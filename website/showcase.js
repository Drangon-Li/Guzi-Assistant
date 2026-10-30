(() => {
  const views = {
    home: { title: '今日工作台', description: '专注、打卡与今日概览，清楚地放在一起。' },
    schedule: { title: '日程安排', description: '把时间和事项排好，给自己留一点从容。' },
    notebook: { title: '随手笔记', description: '一闪而过的想法，也有自己的位置。' },
  };
  const buttons = [...document.querySelectorAll('[data-product-view]')];
  const preview = document.querySelector('#product-image');
  const productOpener = document.querySelector('#open-product-image');
  const dialog = document.querySelector('#product-lightbox');
  const enlarged = document.querySelector('#lightbox-image');
  let productRequest = 0;
  let lastOpener;

  productOpener.setAttribute('data-screenshot', '');
  productOpener.dataset.imageTitle = views.home.title;
  buttons.forEach(button => button.addEventListener('click', async () => {
    const request = ++productRequest;
    const selected = button.dataset.productView;
    const view = views[selected];
    const source = `assets/product-${selected}.jpg`;
    productOpener.setAttribute('aria-busy', 'true');
    try {
      const ready = new Image();
      ready.src = source;
      await ready.decode();
      if (request !== productRequest) return;
      buttons.forEach(item => item.setAttribute('aria-pressed', String(item === button)));
      preview.src = source;
      preview.alt = `谷子助手${view.title}的真实截图，内容为演示数据`;
      productOpener.dataset.imageTitle = view.title;
      productOpener.setAttribute('aria-label', `放大查看${view.title}截图`);
      document.querySelector('#product-image-description').textContent = view.description;
      await preview.decode();
      if (request === productRequest) window.dispatchEvent(new CustomEvent('guzi:product-change', { detail: { name: selected, image: preview } }));
    } catch {
      if (request === productRequest) document.querySelector('#product-image-description').textContent = '截图暂时无法加载，请稍后再次选择。';
    } finally {
      if (request === productRequest) productOpener.removeAttribute('aria-busy');
    }
  }));

  document.addEventListener('click', event => {
    const opener = event.target.closest('button[data-screenshot]');
    if (!opener) return;
    const image = opener.querySelector('img');
    if (!image || !image.complete || !image.naturalWidth) return;
    lastOpener = opener;
    enlarged.src = image.currentSrc || image.src;
    enlarged.alt = image.alt;
    enlarged.width = image.naturalWidth;
    enlarged.height = image.naturalHeight;
    document.querySelector('#lightbox-title').textContent = opener.dataset.imageTitle || '实际应用截图';
    document.querySelector('#original-product-image').href = enlarged.src;
    dialog.showModal();
  });
  document.querySelector('#close-product-image').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => lastOpener?.focus({ preventScroll: true }));
  dialog.addEventListener('click', event => {
    if (event.target === dialog) dialog.close();
  });
})();
