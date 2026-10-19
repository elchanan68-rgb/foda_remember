(() => {
  'use strict';

  const STORAGE_KEY = 'foda-samina-memories-v1';
  const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
  const MAX_IMAGE_DATA_LENGTH = 2_400_000;
  const publicConfig = window.FODA_PUBLIC_CONFIG || {};
  const apiUrl = typeof publicConfig.apiUrl === 'string' && /^https:\/\//i.test(publicConfig.apiUrl) ? publicConfig.apiUrl.replace(/\/$/, '') : '';
  const turnstileSiteKey = typeof publicConfig.turnstileSiteKey === 'string' ? publicConfig.turnstileSiteKey.trim() : '';
  const allowedCategories = new Set(['family', 'food', 'wisdom', 'celebration']);
  const categoryNames = {
    family: 'רגעים משפחתיים',
    food: 'מהמטבח של סבתא',
    wisdom: 'מילים של סבתא',
    celebration: 'שמחות וחגים'
  };

  const grid = document.querySelector('#memoryGrid');
  const gallery = document.querySelector('#galleryGrid');
  const count = document.querySelector('#memoryCount');
  const search = document.querySelector('#searchMemories');
  const dialog = document.querySelector('#memoryDialog');
  const bioDialog = document.querySelector('#bioDialog');
  const bioForm = document.querySelector('#bioForm');
  const form = document.querySelector('#memoryForm');
  const photoInput = document.querySelector('#memoryPhoto');
  const photoStatus = document.querySelector('#photoStatus');
  const storageWarning = document.querySelector('#storageWarning');
  const preview = document.querySelector('#photoPreview');
  const previewImage = document.querySelector('#previewImage');
  const previewName = document.querySelector('#previewName');
  const formMessage = document.querySelector('#formMessage');
  const privacyNote = document.querySelector('#privacyNote');
  const captchaWrap = document.querySelector('#captchaWrap');
  const toast = document.querySelector('#toast');
  const storyInput = document.querySelector('#memoryStory');
  const storyLength = document.querySelector('#storyLength');
  const submitButton = form.querySelector('[type="submit"]');
  const bioSaveButton = document.querySelector('#bioSaveButton');
  const bioFormMessage = document.querySelector('#bioFormMessage');
  let activeFilter = 'all';
  let pendingPhoto = '';
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
    bioForm.elements.namedItem('editCode').value = '';
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
    const candidates = [
      'assets/foda-portrait.jpg', 'assets/Foda-portrait.jpg', 'assets/FODA-PORTRAIT.JPG',
      'assets/foda-portrait.JPG', 'assets/Foda-portrait.JPG', 'assets/FODA-PORTRAIT.jpg',
      'assets/foda-portrait.jpeg', 'assets/Foda-portrait.jpeg', 'Assets/foda-portrait.jpg',
      'Assets/Foda-portrait.jpg', 'Assets/FODA-PORTRAIT.JPG'
    ];
    let candidateIndex = 0;
    image.onerror = () => {
      candidateIndex += 1;
      if (candidateIndex < candidates.length) {
        image.src = candidates[candidateIndex];
      } else {
        image.hidden = true;
        fallback.hidden = false;
      }
    };
    image.onload = () => {
      image.hidden = false;
      fallback.hidden = true;
    };
    if (image.complete && image.naturalWidth === 0) image.onerror();
  }

  function loadMemories() {
    try {
      const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
      if (!Array.isArray(parsed)) return [];
      return parsed.slice(0, 300).map((item) => {
        if (!item || typeof item !== 'object') return null;
        const photo = typeof item.photo === 'string' && item.photo.length <= MAX_IMAGE_DATA_LENGTH && /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(item.photo) ? item.photo : '';
        const category = allowedCategories.has(item.category) ? item.category : 'family';
        return {
          id: typeof item.id === 'string' && item.id.length <= 80 ? item.id : makeId(),
          title: cleanText(item.title, 90),
          author: cleanText(item.author, 50),
          story: cleanText(item.story, 2500),
          category,
          photo,
          createdAt: typeof item.createdAt === 'string' && item.createdAt.length <= 40 ? item.createdAt : new Date().toISOString()
        };
      }).filter((item) => item && item.title && item.author && item.story);
    } catch {
      return [];
    }
  }

  function cleanText(value, maxLength) {
    return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
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

  function normalizeRemoteMemories(rows) {
    if (!Array.isArray(rows)) return [];
    return rows.slice(0, 300).map((row) => {
      if (!row || typeof row !== 'object') return null;
      const category = allowedCategories.has(row.category) ? row.category : 'family';
      return {
        id: cleanText(row.id, 80) || makeId(),
        title: cleanText(row.title, 90),
        author: cleanText(row.author, 50),
        story: cleanText(row.story, 2500),
        category,
        photo: trustedPhotoUrl(row.photoUrl),
        createdAt: typeof row.createdAt === 'string' && row.createdAt.length <= 40 ? row.createdAt : new Date().toISOString()
      };
    }).filter((row) => row && row.title && row.author && row.story);
  }

  async function loadRemoteMemories() {
    if (!apiUrl) return;
    try {
      const response = await fetch(apiUrl, { method: 'GET', mode: 'cors', credentials: 'omit', cache: 'no-store', redirect: 'error' });
      if (!response.ok) throw new Error('השרת החזיר שגיאה.');
      const payload = await response.json();
      memories = normalizeRemoteMemories(payload.memories);
      renderBiography(payload.biography);
      updateStorageWarning(payload.storage);
      setPrivacyNote('הסיפורים והתמונות המשותפים מוצגים כאן. שליחות חדשות יפורסמו לפי הגדרות האישור של המשפחה.');
      render();
    } catch {
      setPrivacyNote('לא הצלחנו להתחבר לאלבום המשותף. כרגע מוצגים רק זיכרונות שנשמרו בדפדפן הזה.');
    }
  }

  function loadTurnstile() {
    if (window.turnstile) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('טעינת בדיקת האבטחה נכשלה.')), 12000);
      window.fodaTurnstileReady = () => { clearTimeout(timer); resolve(); };
      let script = document.querySelector('#turnstileApi');
      if (!script) {
        script = document.createElement('script');
        script.id = 'turnstileApi';
        script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=fodaTurnstileReady';
        script.async = true;
        script.onerror = () => { clearTimeout(timer); reject(new Error('טעינת בדיקת האבטחה נכשלה.')); };
        document.head.append(script);
      }
    });
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
        turnstileWidgetId = window.turnstile.render('#turnstileWidget', { sitekey: turnstileSiteKey, theme: 'light' });
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
    if (memory.photo) {
      const image = element('img', 'memory-photo');
      image.src = memory.photo;
      image.alt = `תמונה לסיפור: ${memory.title}`;
      image.loading = 'lazy';
      card.append(image);
    }
    const body = element('div', 'memory-card-body');
    body.append(element('span', 'memory-category', categoryNames[memory.category]));
    body.append(element('h3', '', memory.title));
    body.append(element('p', 'memory-story', memory.story));
    const byline = element('div', 'memory-byline', memory.author);
    const date = new Date(memory.createdAt);
    byline.append(element('time', 'memory-date', Number.isNaN(date.getTime()) ? '' : new Intl.DateTimeFormat('he-IL', { day: 'numeric', month: 'short', year: 'numeric' }).format(date)));
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
    const photos = memories.filter((memory) => memory.photo);
    if (!photos.length) {
      const empty = element('div', 'gallery-empty');
      empty.append(element('strong', '', 'התמונות המשפחתיות עוד יגיעו'));
      empty.append(element('span', '', 'כשמוסיפים סיפור עם תמונה, היא מצטרפת לכאן אוטומטית.'));
      gallery.append(empty);
      return;
    }
    photos.forEach((memory) => {
      const figure = element('figure', 'gallery-item');
      const image = element('img');
      image.src = memory.photo;
      image.alt = memory.title;
      image.loading = 'lazy';
      const caption = element('figcaption');
      caption.append(element('strong', '', memory.title));
      caption.append(element('span', '', `מאת ${memory.author}`));
      figure.append(image, caption);
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
    pendingPhoto = '';
    photoInput.value = '';
    previewImage.removeAttribute('src');
    previewName.textContent = '';
    preview.hidden = true;
    setPhotoStatus('', '');
  }

  async function openImage(file) {
    if (typeof createImageBitmap === 'function') return createImageBitmap(file);
    return new Promise((resolve, reject) => {
      const image = new Image();
      const objectUrl = URL.createObjectURL(file);
      image.onload = () => {
        URL.revokeObjectURL(objectUrl);
        resolve({ width: image.naturalWidth, height: image.naturalHeight, drawImage: (context, ...args) => context.drawImage(image, ...args), close() {} });
      };
      image.onerror = () => {
        URL.revokeObjectURL(objectUrl);
        reject(new Error('לא ניתן לפתוח את התמונה.'));
      };
      image.src = objectUrl;
    });
  }

  async function detectUploadImageFormat(file) {
    const bytes = new Uint8Array(await file.slice(0, 12).arrayBuffer());
    if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'JPG';
    if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return 'PNG';
    if (bytes.length >= 12 && String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP') return 'WebP';
    return '';
  }

  async function compressPhoto(file) {
    const bitmap = await openImage(file);
    if (!bitmap.width || !bitmap.height) {
      bitmap.close();
      throw new Error('קובץ התמונה לא תקין או לא ניתן לקריאה.');
    }
    if (bitmap.width * bitmap.height > 40_000_000 || Math.max(bitmap.width, bitmap.height) > 12_000) {
      bitmap.close();
      throw new Error('התמונה גדולה מדי לעיבוד.');
    }
    const maxSide = 1500;
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext('2d');
    if (!context) {
      bitmap.close();
      throw new Error('לא ניתן לעבד את התמונה בדפדפן הזה.');
    }
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    bitmap.drawImage(context, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const dataUrl = canvas.toDataURL('image/jpeg', 0.72);
    if (dataUrl.length > MAX_IMAGE_DATA_LENGTH) throw new Error('התמונה עדיין גדולה מדי לאחר הכיווץ.');
    return { dataUrl, width: canvas.width, height: canvas.height, bytes: Math.round(dataUrl.length * 0.75) };
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
  bioDialog.addEventListener('close', () => { bioForm.elements.namedItem('editCode').value = ''; });
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
      fullStory: String(values.get('fullStory') || '').trim(),
      editCode: String(values.get('editCode') || '')
    };
    if (!biography.summary || !biography.fullStory || !biography.editCode) {
      bioFormMessage.textContent = 'צריך למלא תקציר, סיפור מלא וקוד עריכה.';
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
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(biography)
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(typeof result.error === 'string' ? result.error : 'לא הצלחנו לשמור את קורות החיים.');
      renderBiography(result.biography);
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
  photoInput.addEventListener('change', async () => {
    const selectionToken = ++photoSelectionToken;
    formMessage.textContent = '';
    setPhotoStatus('', '');
    const file = photoInput.files?.[0];
    if (!file) return;
    if (file.size === 0) {
      clearPhoto();
      setPhotoStatus('הקובץ ריק. בחרו תמונה אחרת.', 'error');
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      clearPhoto();
      setPhotoStatus('התמונה גדולה מדי. אפשר לבחור תמונה עד 8MB.', 'error');
      return;
    }
    setPhotoStatus('בודקים את סוג התמונה ומכינים תצוגה מקדימה…', 'checking');
    try {
      const format = await detectUploadImageFormat(file);
      if (!format) throw new Error('אפשר להעלות תמונות JPG, PNG או WebP בלבד. שם הקובץ יכול לכלול אותיות גדולות או קטנות.');
      const compressed = await compressPhoto(file);
      if (selectionToken !== photoSelectionToken) return;
      pendingPhoto = compressed.dataUrl;
      previewImage.src = compressed.dataUrl;
      previewName.textContent = file.name.slice(0, 100);
      preview.hidden = false;
      setPhotoStatus(`התמונה תקינה ומוכנה להעלאה · ${format.toUpperCase()} · ${compressed.width}×${compressed.height} · לאחר הכיווץ כ־${Math.max(1, Math.round(compressed.bytes / 1024))}KB`, 'success');
    } catch (error) {
      if (selectionToken !== photoSelectionToken) return;
      const message = error instanceof Error ? error.message : 'לא הצלחנו לפתוח את התמונה. נסו קובץ אחר.';
      clearPhoto();
      setPhotoStatus(message, 'error');
    }
  });
  document.querySelector('#removePhoto').addEventListener('click', clearPhoto);

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    formMessage.textContent = '';
    const data = new FormData(form);
    const title = cleanText(data.get('title'), 90);
    const author = cleanText(data.get('author'), 50);
    const story = cleanText(data.get('story'), 2500);
    const category = allowedCategories.has(data.get('category')) ? data.get('category') : 'family';
    if (!title || !author || !story) {
      formMessage.textContent = 'כדי לשמור, צריך למלא כותרת, שם וסיפור.';
      return;
    }
    if (remoteMode) {
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
        if (pendingPhoto) {
          const photoBlob = dataUrlToBlob(pendingPhoto);
          upload.set('photo', photoBlob, 'family-photo.jpg');
        }
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
    const memory = { id: makeId(), title, author, story, category, photo: pendingPhoto, createdAt: new Date().toISOString() };
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
