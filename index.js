     </div>
   </div>

    <div class="content">
      <div class="search-card" id="searchCard">
        <input id="searchInput" class="search-input" placeholder="品名・カテゴリ・場所を検索" />
      </div>
<div class="content">
  <div class="search-card" id="searchCard">
    <input id="searchInput" class="search-input" placeholder="品名・カテゴリ・場所を検索" />
  </div>

      <div class="tabs-wrap" id="tabsWrap">
        <div class="tabs" id="mainTabs"></div>
      </div>
  <div class="tabs-wrap" id="tabsWrap">
    <div class="tabs" id="mainTabs"></div>
  </div>

      <div class="screen active" id="screenList">
        <div class="items" id="itemsContainer"></div>
      </div>
  <div class="grid-2" id="subFilterWrap" style="margin-bottom:14px;">
    <div class="field" style="margin-bottom:0;">
      <select id="filterCategoryM" class="select">
        <option value="">中分類で絞り込み</option>
      </select>
    </div>
    <div class="field" style="margin-bottom:0;">
      <select id="filterCategoryS" class="select">
        <option value="">小分類で絞り込み</option>
      </select>
    </div>
  </div>

  <div class="screen active" id="screenList">
    <div class="items" id="itemsContainer"></div>
  </div>

     <div class="screen" id="screenCreate">
       <div class="section-title">新規登録</div>
@@ -1727,21 +1740,25 @@ app.get('/inventory', (req, res) => {
     brown:  { accent: '#b98a5f', accent2: '#d0a57f', bg: '#1d130d', card: '#342319' }
   };

    const els = {
      searchCard: document.getElementById('searchCard'),
      tabsWrap: document.getElementById('tabsWrap'),
      searchInput: document.getElementById('searchInput'),
      mainTabs: document.getElementById('mainTabs'),
      itemsContainer: document.getElementById('itemsContainer'),
      refreshBtn: document.getElementById('refreshBtn'),
      screenList: document.getElementById('screenList'),
      screenCreate: document.getElementById('screenCreate'),
      screenAccount: document.getElementById('screenAccount'),
      navList: document.getElementById('navList'),
      navCreate: document.getElementById('navCreate'),
      navAccount: document.getElementById('navAccount'),

const els = {
  searchCard: document.getElementById('searchCard'),
  tabsWrap: document.getElementById('tabsWrap'),
  subFilterWrap: document.getElementById('subFilterWrap'),
  searchInput: document.getElementById('searchInput'),
  filterCategoryM: document.getElementById('filterCategoryM'),
  filterCategoryS: document.getElementById('filterCategoryS'),
  mainTabs: document.getElementById('mainTabs'),
  itemsContainer: document.getElementById('itemsContainer'),
  refreshBtn: document.getElementById('refreshBtn'),
  screenList: document.getElementById('screenList'),
  screenCreate: document.getElementById('screenCreate'),
  screenAccount: document.getElementById('screenAccount'),
  navList: document.getElementById('navList'),
  navCreate: document.getElementById('navCreate'),
  navAccount: document.getElementById('navAccount'),
  
     loginUserLabel: document.getElementById('loginUserLabel'),
      

     photoZone: document.getElementById('photoZone'),
     cameraInput: document.getElementById('cameraInput'),
@@ -2161,51 +2178,86 @@ app.get('/inventory', (req, res) => {
     updateLocationOtherVisibility();
   }

    function renderMainTabs() {
      const tabs = ['all', ...getLargeNames()];
      let html = '';
    function refreshSubFilters() {
  let middleList = [];
  let smallList = [];

      tabs.forEach((key) => {
        const label = key === 'all' ? '在庫一覧' : key;
        html += '<button class="tab ' + (activeMainTab === key ? 'active' : '') + '" data-key="' + escapeHtml(key) + '">' + escapeHtml(label) + '</button>';
      });
  const currentSelectedM = safeText(els.filterCategoryM.value).trim();
  const currentSelectedS = safeText(els.filterCategoryS.value).trim();

      els.mainTabs.innerHTML = html;
  if (activeMainTab !== 'all') {
    middleList = getMiddleNames(activeMainTab);
  }

      els.mainTabs.querySelectorAll('.tab').forEach((btn) => {
        btn.addEventListener('click', () => {
          activeMainTab = btn.getAttribute('data-key');
          filterItems();
        });
      });
    }
  setSelectOptions(els.filterCategoryM, middleList, '中分類で絞り込み');
  if (middleList.includes(currentSelectedM)) {
    els.filterCategoryM.value = currentSelectedM;
  }

    function showScreen(name) {
      els.screenList.classList.remove('active');
      els.screenCreate.classList.remove('active');
      els.screenAccount.classList.remove('active');
      els.navList.classList.remove('active');
      els.navAccount.classList.remove('active');

      els.searchCard.classList.remove('hidden');
      els.tabsWrap.classList.remove('hidden');

      if (name === 'list') {
        els.screenList.classList.add('active');
        els.navList.classList.add('active');
      } else if (name === 'create') {
        els.screenCreate.classList.add('active');
        els.searchCard.classList.add('hidden');
        els.tabsWrap.classList.add('hidden');
      } else if (name === 'account') {
        els.screenAccount.classList.add('active');
        els.navAccount.classList.add('active');
        els.searchCard.classList.add('hidden');
        els.tabsWrap.classList.add('hidden');
      }
  const selectedM = safeText(els.filterCategoryM.value).trim();

      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  if (activeMainTab !== 'all' && selectedM) {
    smallList = getSmallNames(activeMainTab, selectedM);
  }

  setSelectOptions(els.filterCategoryS, smallList, '小分類で絞り込み');
  if (smallList.includes(currentSelectedS)) {
    els.filterCategoryS.value = currentSelectedS;
  }
}

function renderMainTabs() {
  const tabs = ['all', ...getLargeNames()];
  let html = '';

  tabs.forEach((key) => {
    const label = key === 'all' ? '在庫一覧' : key;
    html += '<button class="tab ' + (activeMainTab === key ? 'active' : '') + '" data-key="' + escapeHtml(key) + '">' + escapeHtml(label) + '</button>';
  });

  els.mainTabs.innerHTML = html;

  els.mainTabs.querySelectorAll('.tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      activeMainTab = btn.getAttribute('data-key');
      els.filterCategoryM.value = '';
      els.filterCategoryS.value = '';
      refreshSubFilters();
      filterItems();
    });
  });
}


  function showScreen(name) {
  els.screenList.classList.remove('active');
  els.screenCreate.classList.remove('active');
  els.screenAccount.classList.remove('active');
  els.navList.classList.remove('active');
  els.navAccount.classList.remove('active');

  els.searchCard.classList.remove('hidden');
  els.tabsWrap.classList.remove('hidden');
  els.subFilterWrap.classList.remove('hidden');

  if (name === 'list') {
    els.screenList.classList.add('active');
    els.navList.classList.add('active');
  } else if (name === 'create') {
    els.screenCreate.classList.add('active');
    els.searchCard.classList.add('hidden');
    els.tabsWrap.classList.add('hidden');
    els.subFilterWrap.classList.add('hidden');
  } else if (name === 'account') {
    els.screenAccount.classList.add('active');
    els.navAccount.classList.add('active');
    els.searchCard.classList.add('hidden');
    els.tabsWrap.classList.add('hidden');
    els.subFilterWrap.classList.add('hidden');
  }

  window.scrollTo({ top: 0, behavior: 'smooth' });
}

   function openModal(title, html) {
     els.modalTitle.textContent = title;
@@ -2218,13 +2270,14 @@ app.get('/inventory', (req, res) => {
     els.modalBody.innerHTML = '';
   }

   function filterItems() {
function filterItems() {
 const q = safeText(els.searchInput.value).trim().toLowerCase();
  const selectedM = safeText(els.filterCategoryM.value).trim();
  const selectedS = safeText(els.filterCategoryS.value).trim();

 filteredItems = allItems.filter((item) => {
   const qty = Number(item.qty || 0);

    // 数量0以下は表示しない
   if (qty <= 0) {
     return false;
   }
@@ -2233,6 +2286,14 @@ app.get('/inventory', (req, res) => {
     return false;
   }

    if (selectedM && safeText(item.category_m).trim() !== selectedM) {
      return false;
    }

    if (selectedS && safeText(item.category_s).trim() !== selectedS) {
      return false;
    }

   if (q) {
     const hay = [
       item.name,
@@ -2269,17 +2330,19 @@ app.get('/inventory', (req, res) => {
         const c1 = escapeHtml(cands[1] || '');
         const c2 = escapeHtml(cands[2] || '');

          thumbHtml = '<img src="' + c0 + '" alt="' + escapeHtml(item.name || '') + '"' +
            ' onerror="if(!this.dataset.f1 && \\''
            + c1 +
            '\\'){this.dataset.f1=\\'1\\';this.src=\\'' +
            c1 +
            '\\';return;} if(!this.dataset.f2 && \\''
            + c2 +
            '\\'){this.dataset.f2=\\'1\\';this.src=\\'' +
            c2 +
            '\\';return;} this.onerror=null; this.outerHTML=\\'<span>画像なし</span>\\';"' +
            ' />';
       thumbHtml = '<img src="' + c0 + '" alt="' + escapeHtml(item.name || '') + '"' +
  ' onclick="openImagePreview(this.src, \'' + escapeHtml(item.name || '') + '\')"' +
  ' style="cursor:pointer;"' +
  ' onerror="if(!this.dataset.f1 && \\''
  + c1 +
  '\\'){this.dataset.f1=\\'1\\';this.src=\\'' +
  c1 +
  '\\';return;} if(!this.dataset.f2 && \\''
  + c2 +
  '\\'){this.dataset.f2=\\'1\\';this.src=\\'' +
  c2 +
  '\\';return;} this.onerror=null; this.outerHTML=\\'<span>画像なし</span>\\';"' +
  ' />';
       }

       const chipValues = [item.category_l, item.category_m, item.category_s, item.location]
@@ -2366,15 +2429,16 @@ app.get('/inventory', (req, res) => {
   }

   async function loadMasters() {
      const data = await apiFetch('/api/master');
  const data = await apiFetch('/api/master');

      masterCategories = Array.isArray(data.categories) ? data.categories : [];
      masterLocations = Array.isArray(data.locations) ? data.locations : [];
  masterCategories = Array.isArray(data.categories) ? data.categories : [];
  masterLocations = Array.isArray(data.locations) ? data.locations : [];

      refreshCategorySelects();
      refreshLocationSelect();
      renderMainTabs();
    }
  refreshCategorySelects();
  refreshLocationSelect();
  renderMainTabs();
  refreshSubFilters();
}

   async function loadItems() {
     const data = await apiFetch('/api/items');
@@ -2494,6 +2558,18 @@ app.get('/inventory', (req, res) => {
     }
   }


function openImagePreview(imageUrl, itemName) {
  const html =
    '<div style="text-align:center;">' +
      '<div style="font-weight:800; margin-bottom:10px;">' + escapeHtml(itemName || '') + '</div>' +
      '<img src="' + escapeHtml(imageUrl) + '" alt="' + escapeHtml(itemName || '') + '" ' +
      'style="max-width:100%; max-height:70vh; border-radius:16px; display:block; margin:0 auto;" />' +
    '</div>';

  openModal('写真を表示', html);
}

 async function editItem(itemId) {
 try {
   const item = await apiFetch('/api/items/' + encodeURIComponent(itemId));
@@ -2632,21 +2708,32 @@ async function submitEdit(itemId) {
 }
}

    els.searchInput.addEventListener('input', filterItems);
    els.refreshBtn.addEventListener('click', () => {
      reloadAll().catch((err) => alert(err.message || '更新に失敗しました'));
    });
  els.searchInput.addEventListener('input', filterItems);

    els.categoryL.addEventListener('change', () => {
      els.categoryM.value = '';
      els.categoryS.value = '';
      refreshCategorySelects();
    });
els.filterCategoryM.addEventListener('change', () => {
  els.filterCategoryS.value = '';
  refreshSubFilters();
  filterItems();
});

    els.categoryM.addEventListener('change', () => {
      els.categoryS.value = '';
      refreshCategorySelects();
    });
els.filterCategoryS.addEventListener('change', () => {
  filterItems();
});

els.refreshBtn.addEventListener('click', () => {
  reloadAll().catch((err) => alert(err.message || '更新に失敗しました'));
});

els.categoryL.addEventListener('change', () => {
  els.categoryM.value = '';
  els.categoryS.value = '';
  refreshCategorySelects();
});

els.categoryM.addEventListener('change', () => {
  els.categoryS.value = '';
  refreshCategorySelects();
});

   els.locationSelect.addEventListener('change', updateLocationOtherVisibility);
   els.addLocationBtn.addEventListener('click', addLocation);
@@ -2722,6 +2809,7 @@ async function submitEdit(itemId) {
   window.submitConsume = submitConsume;
   window.editItem = editItem;
   window.submitEdit = submitEdit;
    window.openImagePreview = openImagePreview;
   window.openCameraFromModal = function() {
     closeModal();
     els.cameraInput.click();
@@ -2734,6 +2822,8 @@ async function submitEdit(itemId) {
     closeModal();
     clearSelectedPhoto();
   };

    
 </script>
</body>
</html>
