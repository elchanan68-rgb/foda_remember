(() => {
  'use strict';

  const STORAGE_KEY = 'foda-samina-memories-v1';
  const MAX_UPLOAD_BYTES = 30 * 1024 * 1024;
  const MAX_IMAGE_DATA_LENGTH = 2_400_000;
  const publicConfig = window.FODA_PUBLIC_CONFIG || {};
  const apiUrl = typeof publicConfig.apiUrl === 'string' && /^https:\/\//i.test(publicConfig.apiUrl) ? publicConfig.apiUrl.replace(/\/$/, '') : '';
  const turnstileSiteKey = typeof publicConfig.turnstileSiteKey === 'string' ? publicConfig.turnstileSiteKey.trim() : '';
  const allowedCategories = new Set(['family', 'food', 'wisdom', 'celebration', 'photos']);
  const categoryNames = {
    family: 'רגעים משפחתיים',
    food: 'מהמטבח של סבתא',
    wisdom: 'מילים של סבתא',
    celebration: 'שמחות וחגים',
    photos: 'אלבום תמונות'
  };

  const grid = document.querySelector('#memoryGrid');
  const gallery = document.querySelector('#galleryGrid');
  const loadStatus = document.querySelector('#loadStatus');
  const loadMessage = document.querySelector('#loadMessage');
  const retryLoadButton = document.querySelector('#retryLoad');
  const count = document.querySelector('#memoryCount');
  const search = document.querySelector('#searchMemories');
  const dialog = document.querySelector('#memoryDialog');
  const bioDialog = document.querySelector('#bioDialog');
  const managerDialog = document.querySelector('#managerDialog');
  const bioForm = document.querySelector('#bioForm');
  const form = document.querySelector('#memoryForm');
  const photoInput = document.querySelector('#memoryPhoto');
  const photoStatus = document.querySelector('#photoStatus');
  const storageWarning = document.querySelector('#storageWarning');
  const preview = document.querySelector('#photoPreview');
  const formMessage = document.querySelector('#formMessage');
  const privacyNote = document.querySelector('#privacyNote');
  const captchaWrap = document.querySelector('#captchaWrap');
  const toast = document.querySelector('#toast');
  const storyInput = document.querySelector('#memoryStory');
  const storyLength = document.querySelector('#storyLength');
  const submitButton = form.querySelector('[type="submit"]');
  const bioSaveButton = document.querySelector('#bioSaveButton');
  const bioFormMessage = document.querySelector('#bioFormMessage');
  const managerForm = document.querySelector('#managerForm');
  const managerCodeInput = document.querySelector('#managerCodeInput');
  const managerFormMessage = document.querySelector('#managerFormMessage');
  let activeFilter = 'all';
  let pendingPhotos = [];
  const MAX_PHOTOS = 10;
  let lastRemoteLoad = 0;
  let refreshAt = 0;
  let managerCode = '';
  let photoSelectionToken = 0;
  let turnstileWidgetId = null;
  let toastTimer;
  let memories = loadMemories();
  let remoteMode = Boolean(apiUrl);
  let storageWarningShown = false;
  let currentBiography = null;

  function updateStorageWarning(storage) {
    const warning = storage?.warning === true;
    storageWarning.hidden = !warning;
    if (warning && !storageWarningShown) {
      storageWarningShown = true;
      showToast('התראת אחסון: מכסת התמונות הגיעה ל־80%.');
    }
  }

  function setPhotoStatus(message, state = '') {
    photoStatus.textContent = message;
    photoStatus.dataset.state = state;
  }

  function biographyText(value, maxLength) {
    return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
  }

  function renderBiography(biography) {
    const bio = biography && typeof biography === 'object' ? biography : {};
    currentBiography = {
      summary: biographyText(bio.summary, 1200),
      birthplace: biographyText(bio.birthplace, 240),
      childhood: biographyText(bio.childhood, 1200),
      parents: biographyText(bio.parents, 1200),
      aliyah: biographyText(bio.aliyah, 1800),
      fullStory: biographyText(bio.fullStory, 12000)
    };
    document.querySelector('#bioSummary').textContent = currentBiography.summary || 'סיפור חייה של סבתא פודה ייכתב כאן בידי המשפחה, מתוך זיכרונות, מסמכים ותמונות.';
    const factFields = [
      ['birthplace', '#bioBirthplaceFact', '#bioBirthplace'],
      ['childhood', '#bioChildhoodFact', '#bioChildhood'],
      ['parents', '#bioParentsFact', '#bioParents'],
      ['aliyah', '#bioAliyahFact', '#bioAliyah']
    ];
    let factsVisible = false;
    for (const [key, cardSelector, textSelector] of factFields) {
      const value = currentBiography[key];
      document.querySelector(textSelector).textContent = value;
      document.querySelector(cardSelector).hidden = !value;
      factsVisible ||= Boolean(value);
    }
    document.querySelector('#bioFacts').hidden = !factsVisible;
    document.querySelector('#bioFullStory').textContent = currentBiography.fullStory || 'הסיפור המלא יופיע כאן לאחר שמשפחת סמינה תוסיף ותשמור אותו.';
    document.querySelector('#bioFullDetails').hidden = !currentBiography.fullStory;
    for (const key of ['summary', 'birthplace', 'childhood', 'parents', 'aliyah']) {
      bioForm.elements.namedItem(key).value = currentBiography[key];
    }
    bioForm.elements.namedItem('fullStory').value = currentBiography.fullStory;
  }

  function openBiographyEditor() {
    bioFormMessage.textContent = '';
    if (!remoteMode) {
      showToast('עריכת קורות החיים זמינה לאחר חיבור האתר לאחסון המשותף.');
      return;
    }
    if (!bioDialog.open) bioDialog.showModal();
    bioForm.elements.namedItem('summary').focus();
  }

  function setupPortraitFallback() {
    const image = document.querySelector('#heroPortrait');
    const fallback = document.querySelector('#portraitFallback');
    const missing = () => { image.hidden = true; fallback.hidden = false; };
    image.addEventListener('error', missing);
    if (image.complete && image.naturalWidth === 0) missing();
  }

  function loadMemories() {
    try {
      const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
      if (!Array.isArray(parsed)) return [];
      return parsed.slice(0, 300).map((item) => {
        if (!item || typeof item !== 'object') return null;
        const rawPhotos = Array.isArray(item.photos) ? item.photos : [item.photo];
        const photos = rawPhotos.filter((value) => typeof value === 'string' && value.length <= MAX_IMAGE_DATA_LENGTH && /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(value)).slice(0, MAX_PHOTOS);
        const category = allowedCategories.has(item.category) ? item.category : 'family';
        return {
          id: typeof item.id === 'string' && item.id.length <= 80 ? item.id : makeId(),
          title: cleanText(item.title, 90) || (photos.length ? 'תמונה משפחתית' : 'זיכרון משפחתי'),
          author: cleanText(item.author, 50) || 'בן/בת משפחה',
          story: cleanText(item.story, 2500),
          category,
          photos,
          thumbnailPhotos: Array.isArray(item.thumbnailPhotos) ? item.thumbnailPhotos.filter((value) => typeof value === 'string' && value.length <= MAX_IMAGE_DATA_LENGTH).slice(0, MAX_PHOTOS) : photos,
          createdAt: typeof item.createdAt === 'string' && item.createdAt.length <= 40 ? item.createdAt : new Date().toISOString()
        };
      }).filter((item) => item && (item.story || item.photos.length));
    } catch {
      return [];
    }
  }

  function cleanText(value, maxLength) {
    return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
  }

  function encodeSecretHeader(value) {
    const bytes = new TextEncoder().encode(value);
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return `utf8-base64:${btoa(binary)}`;
  }

  function makeId() {
    return globalThis.crypto?.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  function saveMemories() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(memories));
      return true;
    } catch {
      return false;
    }
  }

  function setPrivacyNote(message) {
    privacyNote.replaceChildren(element('span', '', '♡'), document.createTextNode(` ${message}`));
  }

  function showToast(message) {
    toast.textContent = message;
    toast.classList.add('visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('visible'), 4200);
  }

  function trustedPhotoUrl(value) {
    if (typeof value !== 'string' || !apiUrl) return '';
    try {
      const candidate = new URL(value);
      const api = new URL(apiUrl);
      return candidate.protocol === 'https:' && candidate.hostname === api.hostname ? candidate.href : '';
    } catch {
      return '';
    }
  }

  function remotePhotos(row) {
    const urls = Array.isArray(row.photoUrls) ? row.photoUrls : [row.photoUrl];
    return urls.map(trustedPhotoUrl).filter(Boolean).slice(0, MAX_PHOTOS);
  }

  function remoteThumbnails(row, photos) {
    const urls = Array.isArray(row.thumbnailUrls) ? row.thumbnailUrls : [];
    return photos.map((photo, index) => trustedPhotoUrl(urls[index]) || photo);
  }

  function normalizeRemoteMemories(rows) {
    if (!Array.isArray(rows)) return [];
    return rows.slice(0, 300).map((row) => {
      if (!row || typeof row !== 'object') return null;
      const category = allowedCategories.has(row.category) ? row.category : 'family';
      return {
        id: cleanText(row.id, 80) || makeId(),
        title: cleanText(row.title, 90) || (remotePhotos(row).length ? 'תמונה משפחתית' : 'זיכרון משפחתי'),
        author: cleanText(row.author, 50) || 'בן/בת משפחה',
        story: cleanText(row.story, 2500),
        category,
        status: row.status === 'pending' ? 'pending' : 'approved',
        photos: remotePhotos(row),
        thumbnailPhotos: remoteThumbnails(row, remotePhotos(row)),
        photoIds: Array.isArray(row.photoIds) ? row.photoIds.slice(0, MAX_PHOTOS).map((id) => typeof id === 'string' ? id : '') : [],
        createdAt: typeof row.createdAt === 'string' && row.createdAt.length <= 40 ? row.createdAt : new Date().toISOString()
      };
    }).filter((row) => row && (row.story || row.photos.length));
  }

  async function loadRemoteMemories(managerKey = managerCode) {
    if (!apiUrl) return;
    loadStatus.hidden = false;
    loadStatus.dataset.state = 'loading';
    loadMessage.textContent = 'טוענים את סיפורי המשפחה…';
    retryLoadButton.hidden = true;
    if (!memories.length) grid.replaceChildren(...Array.from({ length: 3 }, () => element('div', 'memory-skeleton')));
    try {
      const headers = managerKey ? { 'x-manager-code': encodeSecretHeader(managerKey) } : {};
      const response = await fetch(apiUrl, { method: 'GET', mode: 'cors', credentials: 'omit', cache: 'no-store', redirect: 'error', headers });
      if (!response.ok) throw new Error('השרת החזיר שגיאה.');
      const payload = await response.json();
      if (managerKey && payload.manager !== true) throw new Error('קוד המנהל שגוי.');
      lastRemoteLoad = Date.now();
      memories = normalizeRemoteMemories(payload.memories);
      renderBiography(payload.biography);
      updateStorageWarning(payload.storage);
      setPrivacyNote('הסיפורים והתמונות המשותפים מוצגים כאן. שליחות חדשות יפורסמו לפי הגדרות האישור של המשפחה.');
      render();
      loadStatus.hidden = true;
      return true;
    } catch (error) {
      setPrivacyNote('לא הצלחנו להתחבר לאלבום המשותף. כרגע מוצגים רק זיכרונות שנשמרו בדפדפן הזה.');
      loadStatus.dataset.state = 'error';
      loadMessage.textContent = 'לא הצלחנו לטעון את האלבום המשותף. בדקו את החיבור ונסו שוב.';
      retryLoadButton.hidden = false;
      if (managerKey) throw error;
      return false;
    }
  }

  retryLoadButton.addEventListener('click', () => loadRemoteMemories());

  let turnstilePromise = null;
  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = src;
      script.async = true;
      script.onload = resolve;
      script.onerror = () => { script.remove(); reject(new Error('script')); };
      document.head.append(script);
    });
  }

  function loadTurnstile() {
    if (window.turnstile) return Promise.resolve();
    if (!turnstilePromise) {
      turnstilePromise = new Promise((resolve, reject) => {
        const timer = setTimeout(() => { turnstilePromise = null; reject(new Error('timeout')); }, 12000);
        window.fodaTurnstileReady = () => { clearTimeout(timer); resolve(); };
        loadScript('https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=fodaTurnstileReady')
          .catch((error) => { clearTimeout(timer); turnstilePromise = null; reject(error); });
      });
    }
    return turnstilePromise;
  }

  async function prepareTurnstile() {
    if (!remoteMode) { captchaWrap.hidden = true; return; }
    if (!turnstileSiteKey) {
      captchaWrap.hidden = true;
      formMessage.textContent = 'החיבור המשותף עדיין לא הוגדר במלואו. יש להוסיף מפתח אתר ציבורי של Turnstile בקובץ ההגדרות.';
      return;
    }
    captchaWrap.hidden = false;
    try {
      await loadTurnstile();
      if (turnstileWidgetId === null) {
        turnstileWidgetId = window.turnstile.render('#turnstileWidget', { sitekey: turnstileSiteKey, theme: 'light', size: 'flexible' });
      } else {
        window.turnstile.reset(turnstileWidgetId);
      }
    } catch {
      formMessage.textContent = 'לא הצלחנו לטעון את בדיקת האבטחה. נסו שוב בעוד רגע.';
    }
  }

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function makeEmptyState() {
    const wrapper = element('div', 'empty-state');
    wrapper.append(element('span', 'empty-flower', '✿'));
    wrapper.append(element('h3', '', memories.length ? 'לא מצאנו סיפור כזה' : 'הזיכרון הראשון מתחיל כאן'));
    wrapper.append(element('p', '', memories.length ? 'אפשר לנסות מילת חיפוש אחרת או לבחור נושא אחר.' : 'שתפו רגע קטן עם סבתא פודה, ותנו לו מקום באלבום המשפחתי.'));
    if (!memories.length) {
      const addButton = element('button', 'button', '＋ הוספת סיפור ראשון');
      addButton.type = 'button';
      addButton.addEventListener('click', openDialog);
      wrapper.append(addButton);
    }
    return wrapper;
  }

  function createMemoryCard(memory) {
    const card = element('article', 'memory-card');
    if (memory.photos.length) {
      const open = element('button', 'memory-photo-button');
      open.type = 'button';
      open.setAttribute('aria-label', `צפייה בתמונות: ${memory.title}`);
      const image = element('img', 'memory-photo');
      image.src = memory.thumbnailPhotos?.[0] || memory.photos[0];
      image.alt = `תמונה לסיפור: ${memory.title}`;
      image.loading = 'lazy';
      image.addEventListener('error', refreshSoon);
      open.append(image);
      if (memory.photos.length > 1) open.append(element('span', 'photo-count', `${memory.photos.length} תמונות`));
      open.addEventListener('click', () => openLightbox(memory.photos.map((photo) => ({ photo, title: memory.title, author: memory.author })), 0));
      card.append(open);
    }
    const body = element('div', 'memory-card-body');
    body.append(element('span', 'memory-category', categoryNames[memory.category]));
    if (memory.status === 'pending' && managerCode) body.append(element('span', 'moderation-badge', 'ממתין לאישור'));
    body.append(element('h3', '', memory.title));
    body.append(element('p', 'memory-story', memory.story));
    const byline = element('div', 'memory-byline', memory.author);
    const date = new Date(memory.createdAt);
    byline.append(element('time', 'memory-date', Number.isNaN(date.getTime()) ? '' : new Intl.DateTimeFormat('he-IL', { day: 'numeric', month: 'short', year: 'numeric' }).format(date)));
    if (managerCode && remoteMode) {
      if (memory.status === 'pending') {
        const actions = element('div', 'moderation-actions');
        const approve = element('button', 'moderation-approve', 'אישור ופרסום');
        approve.type = 'button';
        approve.addEventListener('click', () => moderateMemory(memory, 'approved'));
        const reject = element('button', 'moderation-reject', 'דחייה');
        reject.type = 'button';
        reject.addEventListener('click', () => moderateMemory(memory, 'rejected'));
        actions.append(approve, reject);
        body.append(actions);
      }
      const remove = element('button', 'delete-memory', 'מחיקה');
      remove.type = 'button';
      remove.addEventListener('click', () => deleteMemory(memory));
      byline.append(remove);
    }
    body.append(byline);
    card.append(body);
    return card;
  }

  function render() {
    const query = search.value.trim().toLocaleLowerCase('he');
    const visible = memories.filter((memory) => {
      const matchesFilter = activeFilter === 'all' || memory.category === activeFilter;
      const searchable = `${memory.title} ${memory.author} ${memory.story} ${categoryNames[memory.category]}`.toLocaleLowerCase('he');
      return matchesFilter && (!query || searchable.includes(query));
    });

    count.textContent = String(memories.length);
    grid.replaceChildren();
    if (!visible.length) grid.append(makeEmptyState());
    else visible.forEach((memory) => grid.append(createMemoryCard(memory)));

    gallery.replaceChildren();
    const photos = memories.flatMap((memory) => memory.photos.map((photo, index) => ({
      photo,
      thumbnail: memory.thumbnailPhotos?.[index] || photo,
      title: memory.title,
      author: memory.author,
      memory,
      photoId: memory.photoIds?.[index] || ''
    })));
    if (!photos.length) {
      const empty = element('div', 'gallery-empty');
      empty.append(element('strong', '', 'התמונות המשפחתיות עוד יגיעו'));
      empty.append(element('span', '', 'כשמוסיפים סיפור עם תמונה, היא מצטרפת לכאן אוטומטית.'));
      gallery.append(empty);
      return;
    }
    photos.forEach((memory, index) => {
      const figure = element('figure', 'gallery-item');
      const open = element('button', 'gallery-open');
      open.type = 'button';
      open.setAttribute('aria-label', `פתיחת תמונה: ${memory.title}`);
      const image = element('img');
      image.src = memory.thumbnail;
      image.alt = memory.title;
      image.loading = 'lazy';
      image.addEventListener('error', refreshSoon);
      const caption = element('figcaption');
      caption.append(element('strong', '', memory.title));
      caption.append(element('span', '', `מאת ${memory.author}`));
      open.append(image, caption);
      open.addEventListener('click', () => openLightbox(photos.map(({ photo, title, author }) => ({ photo, title, author })), index));
      figure.append(open);
      if (managerCode && remoteMode && memory.photoId) {
        const controls = element('div', 'photo-admin-actions');
        const cover = element('button', 'photo-cover-button', 'תמונה ראשית');
        cover.type = 'button';
        cover.addEventListener('click', () => photoAction(memory, 'set_cover'));
        const remove = element('button', 'photo-remove-button', 'מחיקת תמונה');
        remove.type = 'button';
        remove.addEventListener('click', () => photoAction(memory, 'delete_photo'));
        controls.append(cover, remove);
        figure.append(controls);
      }
      gallery.append(figure);
    });
  }

  function openDialog() {
    formMessage.textContent = '';
    if (!dialog.open) dialog.showModal();
    prepareTurnstile();
    document.querySelector('#memoryTitle').focus();
  }

  function clearPhoto() {
    photoSelectionToken += 1;
    pendingPhotos.forEach((item) => item.source.close?.());
    pendingPhotos = [];
    photoInput.value = '';
    renderPhotoGrid();
    setPhotoStatus('', '');
  }

  function renderPhotoGrid() {
    preview.replaceChildren();
    preview.hidden = !pendingPhotos.length;
    pendingPhotos.forEach((item) => {
      const thumb = element('figure', 'photo-thumb');
      const image = element('img');
      image.src = item.dataUrl;
      image.alt = `תצוגה מקדימה: ${item.name}`;
      const rotate = element('button', 'thumb-button thumb-rotate', '↻');
      rotate.type = 'button';
      rotate.setAttribute('aria-label', 'סיבוב התמונה');
      rotate.addEventListener('click', () => rotatePhoto(item));
      const remove = element('button', 'thumb-button thumb-remove', '×');
      remove.type = 'button';
      remove.setAttribute('aria-label', 'הסרת התמונה');
      remove.addEventListener('click', () => {
        item.source.close?.();
        pendingPhotos = pendingPhotos.filter((photo) => photo !== item);
        renderPhotoGrid();
        updatePhotoStatus();
      });
      thumb.append(image, rotate, remove, element('figcaption', '', `${Math.max(1, Math.round(item.bytes / 1024))}KB`));
      preview.append(thumb);
    });
  }

  function updatePhotoStatus(failure = '') {
    if (!pendingPhotos.length) { setPhotoStatus(failure, failure ? 'error' : ''); return; }
    const total = Math.round(pendingPhotos.reduce((sum, item) => sum + item.bytes, 0) / 1024);
    const ready = pendingPhotos.length === 1 ? 'תמונה אחת מוכנה' : `${pendingPhotos.length} תמונות מוכנות`;
    setPhotoStatus(`${ready} · כ־${total}KB בסך הכול${failure ? ` · ${failure}` : ''}`, failure ? 'error' : 'success');
  }

  async function decodeBlob(blob) {
    if (typeof createImageBitmap === 'function') {
      for (const options of [{ imageOrientation: 'from-image' }, undefined]) {
        try { return await (options ? createImageBitmap(blob, options) : createImageBitmap(blob)); } catch { /* try next decoder */ }
      }
    }
    return new Promise((resolve, reject) => {
      const image = new Image();
      const url = URL.createObjectURL(blob);
      image.onload = () => { URL.revokeObjectURL(url); image.close = () => {}; resolve(image); };
      image.onerror = () => { URL.revokeObjectURL(url); reject(new Error('decode')); };
      image.src = url;
    });
  }

  async function decodeImage(file, format) {
    try {
      return await decodeBlob(file);
    } catch (error) {
      if (format !== 'HEIC/HEIF') throw error;
      if (!window.heic2any) await loadScript('assets/vendor/heic2any.min.js');
      const converted = await window.heic2any({ blob: file, toType: 'image/jpeg', quality: 0.9 });
      return decodeBlob(Array.isArray(converted) ? converted[0] : converted);
    }
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('read'));
      reader.readAsDataURL(blob);
    });
  }

  async function detectUploadImageFormat(file) {
    const bytes = new Uint8Array(await file.slice(0, 12).arrayBuffer());
    if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'JPG';
    if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return 'PNG';
    if (bytes.length >= 12 && String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP') return 'WebP';
    if (bytes.length >= 12 && String.fromCharCode(...bytes.slice(4, 8)) === 'ftyp') {
      const brand = String.fromCharCode(...bytes.slice(8, 12));
      if (['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1'].includes(brand)) return 'HEIC/HEIF';
      if (brand === 'avif' || brand === 'avis') return 'AVIF';
    }
    if (bytes.length >= 6 && ['GIF87a', 'GIF89a'].includes(String.fromCharCode(...bytes.slice(0, 6)))) return 'GIF';
    return '';
  }

  async function encodePhoto(source, rotation, thumbnail = false) {
    const sw = source.naturalWidth || source.width;
    const sh = source.naturalHeight || source.height;
    if (!sw || !sh) throw new Error('קובץ התמונה לא תקין או לא ניתן לקריאה.');
    if (sw * sh > 100_000_000) throw new Error('התמונה גדולה מדי לעיבוד.');
    const turned = rotation % 180 !== 0;
    const target = thumbnail ? 90_000 : (remoteMode ? 1_200_000 : 450_000);
    let side = thumbnail ? 480 : (remoteMode ? 1800 : 1300);
    let quality = thumbnail ? 0.7 : 0.85;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const scale = Math.min(1, side / Math.max(sw, sh));
      const w = Math.max(1, Math.round(sw * scale));
      const h = Math.max(1, Math.round(sh * scale));
      const canvas = document.createElement('canvas');
      canvas.width = turned ? h : w;
      canvas.height = turned ? w : h;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('לא ניתן לעבד את התמונה בדפדפן הזה.');
      context.fillStyle = '#fff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.translate(canvas.width / 2, canvas.height / 2);
      context.rotate((rotation * Math.PI) / 180);
      context.drawImage(source, -w / 2, -h / 2, w, h);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
      if (!blob) throw new Error('לא ניתן לעבד את התמונה בדפדפן הזה.');
      if (blob.size <= target || attempt === 9) return { blob, width: canvas.width, height: canvas.height };
      if (quality > 0.62) quality -= 0.08; else side *= 0.85;
    }
    throw new Error('התמונה עדיין גדולה מדי לאחר הכיווץ.');
  }

  async function processPhoto(file) {
    if (!file.size) throw new Error('הקובץ ריק.');
    if (file.size > MAX_UPLOAD_BYTES) throw new Error('התמונה גדולה מ־30MB.');
    const format = await detectUploadImageFormat(file);
    if (!format) throw new Error('אפשר להעלות רק תמונות: JPG, PNG, WebP, HEIC, AVIF או GIF.');
    const source = await decodeImage(file, format).catch(() => {
      throw new Error(format === 'HEIC/HEIF' ? 'לא הצלחנו להמיר HEIC. שמרו כ־JPG ונסו שוב.' : 'לא הצלחנו לפתוח את התמונה.');
    });
    try {
      const [{ blob, width, height }, thumbnail] = await Promise.all([encodePhoto(source, 0), encodePhoto(source, 0, true)]);
      return { source, format, rotation: 0, name: file.name || 'photo', dataUrl: await blobToDataUrl(blob), thumbnailDataUrl: await blobToDataUrl(thumbnail.blob), bytes: blob.size, width, height };
    } catch (error) {
      source.close?.();
      throw error;
    }
  }

  async function rotatePhoto(item) {
    item.rotation = (item.rotation + 90) % 360;
    setPhotoStatus('מסובבים…', 'checking');
    try {
      const [{ blob }, thumbnail] = await Promise.all([encodePhoto(item.source, item.rotation), encodePhoto(item.source, item.rotation, true)]);
      item.dataUrl = await blobToDataUrl(blob);
      item.thumbnailDataUrl = await blobToDataUrl(thumbnail.blob);
      item.bytes = blob.size;
      renderPhotoGrid();
      updatePhotoStatus();
    } catch (error) {
      updatePhotoStatus(error instanceof Error ? error.message : 'הסיבוב נכשל.');
    }
  }

  async function addPhotoFiles(files) {
    const token = photoSelectionToken;
    const list = files.filter(Boolean);
    if (!list.length) return;
    formMessage.textContent = '';
    let failure = list.length > MAX_PHOTOS - pendingPhotos.length ? `אפשר לצרף עד ${MAX_PHOTOS} תמונות` : '';
    setPhotoStatus('מכינים את התמונות…', 'checking');
    for (const file of list) {
      if (pendingPhotos.length >= MAX_PHOTOS) break;
      try {
        const item = await processPhoto(file);
        if (token !== photoSelectionToken) { item.source.close?.(); return; }
        pendingPhotos.push(item);
        renderPhotoGrid();
      } catch (error) {
        failure = `${(file.name || 'תמונה').slice(0, 30)}: ${error instanceof Error ? error.message : 'לא נפתחה'}`;
      }
    }
    if (token === photoSelectionToken) updatePhotoStatus(failure);
  }

  document.querySelectorAll('[data-open-form]').forEach((button) => button.addEventListener('click', openDialog));
  setupPortraitFallback();
  document.querySelector('#closeDialog').addEventListener('click', () => dialog.close());
  document.querySelector('#cancelDialog').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close();
  });
  document.querySelectorAll('[data-open-bio-editor]').forEach((button) => button.addEventListener('click', openBiographyEditor));
  document.querySelectorAll('[data-close-bio-editor]').forEach((button) => button.addEventListener('click', () => bioDialog.close()));
  bioDialog.addEventListener('click', (event) => {
    if (event.target === bioDialog) bioDialog.close();
  });
  bioForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    bioFormMessage.textContent = '';
    const values = new FormData(bioForm);
    const biography = {
      summary: String(values.get('summary') || '').trim(),
      birthplace: String(values.get('birthplace') || '').trim(),
      childhood: String(values.get('childhood') || '').trim(),
      parents: String(values.get('parents') || '').trim(),
      aliyah: String(values.get('aliyah') || '').trim(),
      fullStory: String(values.get('fullStory') || '').trim()
    };
    if (!biography.summary || !biography.fullStory) {
      bioFormMessage.textContent = 'צריך למלא תקציר קצר וסיפור מלא.';
      return;
    }
    const familyCode = String(values.get('familyCode') || '').trim();
    if (!familyCode) {
      bioFormMessage.textContent = 'צריך להזין את הקוד המשפחתי.';
      return;
    }
    bioSaveButton.disabled = true;
    try {
      const response = await fetch(apiUrl, {
        method: 'POST',
        mode: 'cors',
        credentials: 'omit',
        cache: 'no-store',
        redirect: 'error',
        headers: { 'Content-Type': 'application/json', 'x-family-code': encodeSecretHeader(familyCode) },
        body: JSON.stringify(biography)
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(typeof result.error === 'string' ? result.error : 'לא הצלחנו לשמור את קורות החיים.');
      renderBiography(result.biography);
      bioForm.elements.namedItem('familyCode').value = '';
      bioDialog.close();
      showToast('קורות החיים נשמרו והוצגו באתר המשפחתי.');
    } catch (error) {
      bioFormMessage.textContent = error instanceof Error ? error.message : 'לא הצלחנו לשמור את קורות החיים.';
    } finally {
      bioSaveButton.disabled = false;
    }
  });
  document.querySelectorAll('[data-filter]').forEach((button) => {
    button.addEventListener('click', () => {
      activeFilter = button.dataset.filter;
      document.querySelectorAll('[data-filter]').forEach((chip) => {
        const active = chip === button;
        chip.classList.toggle('active', active);
        chip.setAttribute('aria-pressed', String(active));
      });
      render();
    });
  });
  search.addEventListener('input', render);
  storyInput.addEventListener('input', () => { storyLength.textContent = String(storyInput.value.length); });
  photoInput.addEventListener('change', () => {
    const files = [...(photoInput.files || [])];
    photoInput.value = '';
    addPhotoFiles(files);
  });
  const dropzone = document.querySelector('.upload-area');
  ['dragenter', 'dragover'].forEach((type) => dropzone.addEventListener(type, (event) => { event.preventDefault(); dropzone.classList.add('dragging'); }));
  ['dragleave', 'drop'].forEach((type) => dropzone.addEventListener(type, () => dropzone.classList.remove('dragging')));
  dropzone.addEventListener('drop', (event) => { event.preventDefault(); addPhotoFiles([...(event.dataTransfer?.files || [])]); });
  dialog.addEventListener('paste', (event) => {
    const files = [...(event.clipboardData?.files || [])].filter((item) => item.type.startsWith('image/'));
    if (files.length) addPhotoFiles(files);
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    formMessage.textContent = '';
    const data = new FormData(form);
    const titleInput = cleanText(data.get('title'), 90);
    const authorInput = cleanText(data.get('author'), 50);
    const story = cleanText(data.get('story'), 2500);
    const category = allowedCategories.has(data.get('category')) ? data.get('category') : 'family';
    if (!pendingPhotos.length && !story) {
      formMessage.textContent = 'כדי לשמור, צריך לצרף תמונה או לכתוב סיפור קצר.';
      return;
    }
    const title = titleInput || (pendingPhotos.length ? `תמונה – ${categoryNames[category]}` : 'זיכרון משפחתי');
    const author = authorInput || 'בן/בת משפחה';
    if (remoteMode) {
      if (pendingPhotos.length && !cleanText(data.get('approvalCode'), 128)) {
        formMessage.textContent = 'כדי להעלות תמונה צריך להזין את הקוד המשפחתי. בלי קוד אפשר לשלוח סיפור בלי תמונה, והוא ימתין לאישור.';
        document.querySelector('#approvalCode').focus();
        return;
      }
      if (!turnstileSiteKey || !window.turnstile || turnstileWidgetId === null) {
        formMessage.textContent = 'החיבור המשותף עדיין לא מוכן. נסו שוב מאוחר יותר.';
        return;
      }
      const challengeToken = window.turnstile.getResponse(turnstileWidgetId);
      if (!challengeToken) {
        formMessage.textContent = 'צריך להשלים את בדיקת האבטחה לפני שליחת הזיכרון.';
        return;
      }
      const upload = new FormData();
      upload.set('title', title);
      upload.set('author', author);
      upload.set('story', story);
      upload.set('category', category);
      upload.set('website', cleanText(data.get('website'), 200));
      const approvalCode = cleanText(data.get('approvalCode'), 128);
      if (approvalCode) upload.set('approvalCode', approvalCode);
      try {
        pendingPhotos.forEach((item, index) => {
          upload.append('photo', dataUrlToBlob(item.dataUrl), `family-photo-${index + 1}.jpg`);
          upload.append('thumbnail', dataUrlToBlob(item.thumbnailDataUrl), `family-thumbnail-${index + 1}.jpg`);
        });
        submitButton.disabled = true;
        const response = await fetch(apiUrl, {
          method: 'POST',
          mode: 'cors',
          credentials: 'omit',
          cache: 'no-store',
          redirect: 'error',
          headers: { 'x-turnstile-token': challengeToken },
          body: upload
        });
        const result = await response.json().catch(() => ({}));
        updateStorageWarning(result.storage);
        if (!response.ok) throw new Error(typeof result.error === 'string' ? result.error : 'לא הצלחנו לשלוח את הזיכרון.');
        form.reset();
        storyLength.textContent = '0';
        clearPhoto();
        dialog.close();
        window.turnstile.reset(turnstileWidgetId);
        if (result.pending === false) {
          showToast(result.storage?.warning
            ? 'הזיכרון פורסם. התראת אחסון: מכסת התמונות הגיעה ל־80% והעלאות תמונה נעצרו.'
            : 'תודה! הזיכרון פורסם באלבום המשפחתי.');
          await loadRemoteMemories();
        } else {
          showToast(result.storage?.warning
            ? 'הזיכרון נשלח לבדיקה. התראת אחסון: מכסת התמונות הגיעה ל־80% והעלאות תמונה נעצרו.'
            : 'תודה! הזיכרון נשלח לבדיקה ויופיע לאחר אישור.');
        }
      } catch (error) {
        formMessage.textContent = error.message === 'Failed to fetch' ? 'השליחה נכשלה. בדקו את החיבור לאינטרנט ונסו שוב.' : error.message;
        if (window.turnstile && turnstileWidgetId !== null) window.turnstile.reset(turnstileWidgetId);
      } finally {
        submitButton.disabled = false;
      }
      return;
    }
    const memory = { id: makeId(), title, author, story, category, photos: pendingPhotos.map((item) => item.dataUrl), thumbnailPhotos: pendingPhotos.map((item) => item.thumbnailDataUrl), createdAt: new Date().toISOString() };
    memories.unshift(memory);
    if (!saveMemories()) {
      memories.shift();
      formMessage.textContent = 'אין מספיק מקום פנוי בדפדפן. נסו להקטין תמונות או להסיר נתונים שמורים.';
      return;
    }
    form.reset();
    storyLength.textContent = '0';
    clearPhoto();
    dialog.close();
    activeFilter = 'all';
    document.querySelectorAll('[data-filter]').forEach((chip) => {
      const active = chip.dataset.filter === 'all';
      chip.classList.toggle('active', active);
      chip.setAttribute('aria-pressed', String(active));
    });
    search.value = '';
    render();
    showToast('הזיכרון נשמר בדפדפן הזה.');
    document.querySelector('#memories-title').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  render();
  renderBiography(null);
  if (remoteMode) {
    setPrivacyNote('הסיפורים המשותפים מוצגים כאן. סיפורים חדשים יופיעו לאחר אישור מנהל האתר.');
    loadRemoteMemories();
  }

  async function deleteMemory(memory) {
    if (!window.confirm(`למחוק את "${memory.title}" לצמיתות?`)) return;
    try {
      const response = await fetch(apiUrl, {
        method: 'DELETE', mode: 'cors', credentials: 'omit', cache: 'no-store', redirect: 'error',
        headers: { 'Content-Type': 'application/json', 'x-manager-code': encodeSecretHeader(managerCode) },
        body: JSON.stringify({ id: memory.id })
      });
      const result = await response.json().catch(() => ({}));
      if (response.status === 403) { managerCode = ''; render(); loadRemoteMemories(); }
      if (!response.ok) throw new Error(typeof result.error === 'string' ? result.error : 'המחיקה נכשלה.');
      showToast(result.warning || 'הזיכרון נמחק.');
      await loadRemoteMemories();
    } catch (error) {
      showToast(error instanceof Error && error.message !== 'Failed to fetch' ? error.message : 'המחיקה נכשלה. בדקו את החיבור.');
    }
  }
  document.querySelector('#managerToggle').addEventListener('click', () => {
    if (!remoteMode) { showToast('ניהול זמין לאחר חיבור האתר לאחסון המשותף.'); return; }
    if (managerCode) { managerCode = ''; loadRemoteMemories(); showToast('מצב ניהול כבוי.'); return; }
    managerFormMessage.textContent = '';
    managerForm.reset();
    managerDialog.showModal();
    managerCodeInput.focus();
  });

  document.querySelector('#closeManagerDialog').addEventListener('click', () => managerDialog.close());
  document.querySelector('#cancelManagerDialog').addEventListener('click', () => managerDialog.close());
  managerDialog.addEventListener('click', (event) => { if (event.target === managerDialog) managerDialog.close(); });
  managerForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const candidate = String(new FormData(managerForm).get('managerCode') || '').trim();
    if (!candidate || candidate.length > 128) { managerFormMessage.textContent = 'יש להזין קוד מנהל.'; return; }
    const submit = managerForm.querySelector('[type="submit"]');
    submit.disabled = true;
    managerFormMessage.textContent = 'בודקים את הקוד…';
    try {
      await loadRemoteMemories(candidate);
      managerCode = candidate;
      managerCodeInput.value = '';
      managerDialog.close();
      render();
      showToast('מצב ניהול פעיל. אפשר לטפל בזיכרונות ממתינים ולמחוק פריטים.');
    } catch (error) {
      managerFormMessage.textContent = error instanceof Error ? error.message : 'לא הצלחנו לאמת את קוד המנהל.';
    } finally {
      submit.disabled = false;
    }
  });

  async function moderateMemory(memory, status) {
    const action = status === 'approved' ? 'לפרסם' : 'לדחות';
    if (!window.confirm(`האם ${action} את „${memory.title}”?`)) return;
    try {
      const response = await fetch(apiUrl, {
        method: 'PATCH', mode: 'cors', credentials: 'omit', cache: 'no-store', redirect: 'error',
        headers: { 'Content-Type': 'application/json', 'x-manager-code': encodeSecretHeader(managerCode) },
        body: JSON.stringify({ id: memory.id, status })
      });
      const result = await response.json().catch(() => ({}));
      if (response.status === 403) { managerCode = ''; loadRemoteMemories(); }
      if (!response.ok) throw new Error(typeof result.error === 'string' ? result.error : 'לא הצלחנו לעדכן את הזיכרון.');
      await loadRemoteMemories();
      showToast(status === 'approved' ? 'הזיכרון אושר ופורסם.' : 'הזיכרון נדחה ולא יוצג למבקרים.');
    } catch (error) {
      showToast(error instanceof Error && error.message !== 'Failed to fetch' ? error.message : 'לא הצלחנו לעדכן את הזיכרון. בדקו את החיבור.');
    }
  }

  async function photoAction(photo, action) {
    const isCover = action === 'set_cover';
    if (!isCover && !window.confirm(`למחוק את התמונה „${photo.title}” לצמיתות?`)) return;
    try {
      const response = await fetch(apiUrl, {
        method: 'PATCH', mode: 'cors', credentials: 'omit', cache: 'no-store', redirect: 'error',
        headers: { 'Content-Type': 'application/json', 'x-manager-code': encodeSecretHeader(managerCode) },
        body: JSON.stringify({ id: photo.memory.id, photoId: photo.photoId, action })
      });
      const result = await response.json().catch(() => ({}));
      if (response.status === 403) { managerCode = ''; loadRemoteMemories(); }
      if (!response.ok) throw new Error(typeof result.error === 'string' ? result.error : 'לא הצלחנו לעדכן את התמונה.');
      await loadRemoteMemories();
      showToast(result.warning || (isCover ? 'תמונת השער הוחלפה.' : 'התמונה נמחקה.'));
    } catch (error) {
      showToast(error instanceof Error && error.message !== 'Failed to fetch' ? error.message : 'לא הצלחנו לעדכן את התמונה. בדקו את החיבור.');
    }
  }

  function refreshSoon() {
    if (!remoteMode || Date.now() - refreshAt < 30000) return;
    refreshAt = Date.now();
    loadRemoteMemories();
  }
  document.addEventListener('visibilitychange', () => {
    if (remoteMode && !document.hidden && Date.now() - lastRemoteLoad > 20 * 60 * 1000) loadRemoteMemories();
  });

  const lightbox = document.querySelector('#lightbox');
  let lbPhotos = [];
  let lbIndex = 0;
  let lbStartX = 0;
  function showLightbox() {
    const memory = lbPhotos[lbIndex];
    document.querySelector('#lbImg').src = memory.photo;
    document.querySelector('#lbImg').alt = memory.title;
    document.querySelector('#lbCap').textContent = `${memory.title} · מאת ${memory.author}`;
    document.querySelector('#lbCount').textContent = `${lbIndex + 1} / ${lbPhotos.length}`;
  }
  function openLightbox(list, index) {
    lbPhotos = list;
    lbIndex = index;
    showLightbox();
    if (!lightbox.open) lightbox.showModal();
  }
  function stepLightbox(delta) {
    lbIndex = (lbIndex + delta + lbPhotos.length) % lbPhotos.length;
    showLightbox();
  }
  document.querySelector('#lbClose').addEventListener('click', () => lightbox.close());
  document.querySelector('#lbPrev').addEventListener('click', () => stepLightbox(-1));
  document.querySelector('#lbNext').addEventListener('click', () => stepLightbox(1));
  lightbox.addEventListener('click', (event) => { if (event.target === lightbox) lightbox.close(); });
  lightbox.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowLeft') stepLightbox(1);
    if (event.key === 'ArrowRight') stepLightbox(-1);
  });
  lightbox.addEventListener('pointerdown', (event) => { lbStartX = event.clientX; });
  lightbox.addEventListener('pointerup', (event) => {
    const dx = event.clientX - lbStartX;
    if (Math.abs(dx) > 60) stepLightbox(dx < 0 ? 1 : -1);
  });

  function dataUrlToBlob(dataUrl) {
    const [header, encoded] = dataUrl.split(',');
    const mime = header.match(/^data:(image\/(?:jpeg|png|webp));base64$/)?.[1];
    if (!mime || encoded.length > MAX_IMAGE_DATA_LENGTH) throw new Error('התמונה אינה תקינה. בחרו תמונה אחרת.');
    const binary = atob(encoded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    if (bytes.byteLength > MAX_UPLOAD_BYTES) throw new Error('התמונה גדולה מדי לאחר הכיווץ.');
    return new Blob([bytes], { type: mime });
  }
})();
