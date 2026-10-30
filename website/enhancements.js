(() => {
  const root = document.documentElement;
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const activeAnimations = new Set();
  const animationByElement = new WeakMap();
  const mayAnimate = () => !reducedMotion.matches && root.dataset.motion !== 'paused';

  const shapes = {
    sprout: '<path d="M12 21v-9M12 15C5 15 3 11 3 6c6 0 9 3 9 9ZM12 12c0-6 3-9 9-9 0 6-3 9-9 9Z"/>',
    flower: '<path d="M12 8c-6-8-11 1-5 4-6 3-1 12 5 4 6 8 11-1 5-4 6-3 1-12-5-4Z"/><circle cx="12" cy="12" r="2"/>',
    bell: '<path d="M5 17h14l-2-3V9a5 5 0 0 0-10 0v5l-2 3ZM10 21h4M12 2v2"/>',
    clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7v5l3 2"/>',
    focus: '<circle cx="12" cy="13" r="8"/><path d="M9 2h6M12 2v3M12 9v4l2 2M18 5l2 2"/>',
    habit: '<rect x="4" y="5" width="16" height="16" rx="3"/><path d="M8 3v4M16 3v4M4 10h16M8 15l2.5 2.5L16 13"/>',
    medal: '<circle cx="12" cy="9" r="6"/><path d="m8 14-1 7 5-3 5 3-1-7M10 9l1.5 1.5L14 8"/>',
    notebook: '<rect x="5" y="3" width="15" height="18" rx="2"/><path d="M9 3v18M3 7h4M3 12h4M3 17h4M12 8h5M12 12h4"/>',
    grid: '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M4 10h16M10 10v10"/>',
    model: '<path d="M4 5h12a3 3 0 0 1 3 3v7H9l-5 4V5ZM8 2v3M19 9h3v11l-4-3h-6v-2"/>',
    moon: '<path d="M20 14A8.5 8.5 0 0 1 10 4a8.5 8.5 0 1 0 10 10Z"/>',
    upRight: '<path d="M6 18 18 6M6 6h12v12"/>',
    down: '<path d="M12 4v16m-6-6 6 6 6-6"/>',
    up: '<path d="M12 20V4m-6 6 6-6 6 6"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    erase: '<path d="m9 5-7 7 7 7h12V5H9ZM12 9l6 6M18 9l-6 6"/>',
    pause: '<path d="M8 5v14M16 5v14"/>',
  };

  function replaceIcon(element, name) {
    if (!element || !shapes[name]) return;
    element.classList.add('guzi-icon-host');
    element.setAttribute('aria-hidden', 'true');
    element.innerHTML = `<svg class="guzi-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${shapes[name]}</svg>`;
  }

  [
    ['.small-sun, .focus-flower', 'flower'],
    ['.scene-spark, .window-leaf, .nudge-symbol, .demo-placeholder > span, .notification-rest', 'sprout'],
    ['.reminder-bell', 'bell'],
    ['.ai-boundary-icon', 'model'],
    ['.routine-note > span', 'moon'],
  ].forEach(([selector, icon]) => {
    document.querySelectorAll(selector).forEach((element) => replaceIcon(element, icon));
  });

  const pluginIcons = { routine: 'clock', focus: 'focus', habit: 'habit', achievement: 'medal', notebook: 'notebook' };
  document.querySelectorAll('[data-plugin]').forEach((button) => {
    replaceIcon(button.querySelector('.plugin-symbol'), pluginIcons[button.dataset.plugin]);
  });

  document.querySelectorAll('.rail-item').forEach((element, index) => {
    replaceIcon(element, ['grid', 'clock', 'notebook'][index]);
  });

  const arrows = { '↗': 'upRight', '↓': 'down', '↑': 'up', '＋': 'plus', '⌫': 'erase', 'Ⅱ': 'pause' };
  document.querySelectorAll('.button > span[aria-hidden], .text-link > span[aria-hidden], .plugin-arrow, .nav-download > span, .back-top > span, .release-links a > span, .windows-release > span, .windows-download > span:last-child, .data-actions > span > span').forEach((element) => {
    replaceIcon(element, arrows[element.textContent.trim()]);
  });

  function animate(element, frames, options = {}, onSettled) {
    if (!element || !mayAnimate() || typeof element.animate !== 'function') return;
    animationByElement.get(element)?.cancel();
    const animation = element.animate(frames, {
      duration: 460,
      fill: 'backwards',
      easing: 'cubic-bezier(.2,.7,.2,1)',
      ...options,
    });
    activeAnimations.add(animation);
    animationByElement.set(element, animation);
    const release = () => {
      activeAnimations.delete(animation);
      onSettled?.();
    };
    animation.addEventListener('finish', release, { once: true });
    animation.addEventListener('cancel', release, { once: true });
  }

  function settleMotion() {
    if (!mayAnimate()) {
      activeAnimations.forEach((animation) => animation.cancel());
      activeAnimations.clear();
    }
  }
  new MutationObserver(settleMotion).observe(root, { attributes: true, attributeFilter: ['data-motion'] });
  reducedMotion.addEventListener('change', settleMotion);
  window.addEventListener('guzi:motion', ({ detail }) => {
    if (detail?.paused) {
      activeAnimations.forEach((animation) => animation.cancel());
      activeAnimations.clear();
    }
  });
  window.addEventListener('pagehide', () => {
    activeAnimations.forEach((animation) => animation.cancel());
    activeAnimations.clear();
  });

  document.querySelectorAll('.hero-intro, .hero h1, .hero-subtitle, .hero-description, .hero-actions').forEach((element, index) => {
    animate(element, [
      { opacity: 0.45, transform: 'translateY(5px)' },
      { opacity: 1, transform: 'translateY(0)' },
    ], { duration: 620, delay: index * 65 });
  });

  function revealScreen(element) {
    animate(element, [
      { opacity: 0.45, transform: 'perspective(1400px) rotate(-1.2deg) scale(.985)' },
      { opacity: 1, transform: 'perspective(1400px) rotate(0deg) scale(1)' },
    ], { duration: 850 });
  }

  revealScreen(document.querySelector('.hero-product-frame'));

  if ('IntersectionObserver' in window) {
    const observer = new IntersectionObserver((entries) => {
      entries.forEach(({ target, isIntersecting }) => {
        if (!isIntersecting) return;
        observer.unobserve(target);
        if (target.matches('.story-screen, #plugin-preview, .product-screenshot-frame')) {
          revealScreen(target);
        } else if (target.matches('.work-timeline')) {
          animate(target, [
            { opacity: 0.5, transform: 'scaleX(.94)' },
            { opacity: 1, transform: 'scaleX(1)' },
          ], { duration: 750 });
        } else {
          animate(target, [{ opacity: 0.45 }, { opacity: 1 }], { duration: 720 });
        }
      });
    }, { threshold: 0.18 });
    document.querySelectorAll('.section-heading, .care-copy h2, .privacy-copy h2, .faq-heading, .story-screen, #plugin-preview, .product-screenshot-frame, .work-timeline').forEach((element) => observer.observe(element));
  }

  const imageSnapshots = new WeakMap();
  const overlays = new WeakMap();

  function imageFrame(image) {
    const frame = image.closest('.story-screenshot, .story-screen, #plugin-preview, .product-screenshot-frame');
    return frame === image ? image.parentElement : frame;
  }

  function rememberImage(image) {
    const frame = image && imageFrame(image);
    if (frame) imageSnapshots.set(frame, image.currentSrc || image.src);
  }

  document.querySelectorAll('#story-image, #plugin-preview img, #product-image').forEach(rememberImage);

  function crossfade(image) {
    if (!image) return;
    const frame = imageFrame(image);
    if (!frame) return;
    const currentSource = image.currentSrc || image.src;
    const previousSource = imageSnapshots.get(frame);
    imageSnapshots.set(frame, currentSource);
    overlays.get(frame)?.remove();
    if (!mayAnimate() || previousSource === currentSource) return;

    if (previousSource) {
      const overlay = image.cloneNode(false);
      overlay.removeAttribute('id');
      overlay.removeAttribute('srcset');
      overlay.removeAttribute('sizes');
      overlay.removeAttribute('loading');
      overlay.src = previousSource;
      overlay.alt = '';
      overlay.setAttribute('aria-hidden', 'true');
      overlay.classList.add('screenshot-transition-overlay');
      Object.assign(overlay.style, {
        left: `${image.offsetLeft}px`,
        top: `${image.offsetTop}px`,
        width: `${image.offsetWidth}px`,
        height: `${image.offsetHeight}px`,
        objectFit: getComputedStyle(image).objectFit,
      });
      frame.append(overlay);
      overlays.set(frame, overlay);
      animate(overlay, [{ opacity: 1 }, { opacity: 0 }], { duration: 420 }, () => {
        overlay.remove();
        if (overlays.get(frame) === overlay) overlays.delete(frame);
      });
    }
    animate(image, [{ opacity: 0.3 }, { opacity: 1 }], { duration: 420 });
  }

  let previousStoryStep = Number(document.querySelector('#task-demo')?.dataset.stage || 0);
  window.addEventListener('guzi:story-change', ({ detail }) => {
    const step = detail.step;
    if (step === previousStoryStep) return;
    const image = document.querySelector('#story-image');
    const chat = document.querySelector('#story-chat');
    const frame = image && imageFrame(image);
    const overlay = frame && overlays.get(frame);
    animationByElement.get(overlay)?.cancel();
    overlay?.remove();
    if (frame) overlays.delete(frame);
    animationByElement.get(image)?.cancel();
    animationByElement.get(chat)?.cancel();
    animationByElement.get(document.querySelector('#story-screen'))?.cancel();

    if (step !== 0 && previousStoryStep !== 0) {
      crossfade(detail.image);
    } else {
      if (step !== 0) rememberImage(detail.image);
      animate(step === 0 ? chat : detail.image, [
        { opacity: 0.4, transform: 'translateY(4px)' },
        { opacity: 1, transform: 'translateY(0)' },
      ], { duration: 340 });
    }
    previousStoryStep = step;
  });

  [
    ['guzi:plugin-change', '#plugin-preview img'],
    ['guzi:product-change', '#product-image'],
  ].forEach(([eventName, selector]) => {
    window.addEventListener(eventName, ({ detail }) => crossfade(detail?.image || document.querySelector(selector)));
  });

  document.querySelectorAll('.faq-list details').forEach((details) => {
    details.addEventListener('toggle', () => {
      if (details.open) animate(details.querySelector('.faq-answer'), [{ opacity: 0.45 }, { opacity: 1 }], { duration: 220 });
    });
  });
})();
