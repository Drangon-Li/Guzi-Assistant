(() => {
  const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
  const motionButton = document.querySelector('#motion-toggle');
  let motionPreference = null;
  try { motionPreference = sessionStorage.getItem('guzi-motion'); } catch {}

  function renderMotion(paused) {
    document.documentElement.dataset.motion = paused ? 'paused' : 'running';
    if (motionButton) {
      motionButton.setAttribute('aria-pressed', String(paused));
      motionButton.textContent = paused ? '开启动效' : '暂停动效';
    }
  }

  function chooseMotion(paused) {
    motionPreference = paused ? 'paused' : 'running';
    try { sessionStorage.setItem('guzi-motion', motionPreference); } catch {}
    window.dispatchEvent(new CustomEvent('guzi:motion', { detail: { paused } }));
  }

  renderMotion(motionPreference ? motionPreference === 'paused' : motionQuery.matches);
  window.addEventListener('guzi:motion', ({ detail }) => {
    renderMotion(detail.paused);
    motionPreference = detail.paused ? 'paused' : 'running';
    try { sessionStorage.setItem('guzi-motion', motionPreference); } catch {}
  });
  motionButton?.addEventListener('click', () => {
    chooseMotion(document.documentElement.dataset.motion !== 'paused');
  });
  motionQuery.addEventListener('change', (event) => {
    if (motionPreference === null) {
      renderMotion(event.matches);
    }
  });

  const menuButton = document.querySelector('#menu-toggle');
  const navigation = document.querySelector('#site-nav');
  function closeMenu() {
    menuButton.setAttribute('aria-expanded', 'false');
    navigation.classList.remove('is-open');
  }
  menuButton.addEventListener('click', () => {
    const open = menuButton.getAttribute('aria-expanded') !== 'true';
    menuButton.setAttribute('aria-expanded', String(open));
    navigation.classList.toggle('is-open', open);
  });
  navigation.addEventListener('click', (event) => {
    if (event.target.closest('a')) closeMenu();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && menuButton.getAttribute('aria-expanded') === 'true') {
      closeMenu();
      menuButton.focus();
    }
  });

  async function prepareImage(source) {
    const image = new Image();
    image.src = source;
    await image.decode();
    return image;
  }

  const story = document.querySelector('#task-demo');
  const storyScreen = document.querySelector('#story-screen');
  const storyChat = document.querySelector('#story-chat');
  const storyScreenshot = document.querySelector('#story-screenshot');
  const storyImage = document.querySelector('#story-image');
  const storyStatus = document.querySelector('#story-status');
  const storyButtons = [...document.querySelectorAll('[data-story-step]')];
  const playButton = document.querySelector('#story-play');
  const replayButton = document.querySelector('#story-replay');
  const playbackHint = document.querySelector('.story-play-hint');
  const storySteps = [
    { status: '从一段消息开始，把需要记住的事交给谷子。' },
    { status: '识别出项目会：11 月 6 日 15:00，302 会议室。确认前，先看一眼结果。', source: 'assets/task-detected.jpg', title: '谷子识别结果', alt: '谷子助手实际识别出11月6日15:00在302会议室参加项目会，等待用户确认' },
    { status: '确认后记下：11 月 6 日 15:00 参加项目会，地点是 302 会议室，记得带上新版方案。', source: 'assets/task-saved.jpg', title: '确认后的任务安排', alt: '谷子助手中已确认的项目会：11月6日15:00，302会议室，需带上新版方案。内容为演示数据' },
  ];
  let storyStep = 0;
  let storyRequest = 0;
  let playing = false;
  let storyTimer;
  let storyVisible = false;

  function playbackAllowed() {
    return storyVisible && !document.hidden && !motionQuery.matches && document.documentElement.dataset.motion !== 'paused';
  }

  function renderPlayback() {
    playButton.textContent = playing ? '暂停演示 Ⅱ' : '播放演示 ▷';
    playButton.setAttribute('aria-pressed', String(playing));
    playButton.disabled = !playbackAllowed();
    playbackHint.textContent = motionQuery.matches || document.documentElement.dataset.motion === 'paused'
      ? '动效已暂停，仍可点击三个步骤查看。'
      : '每步停留 5 秒，播完就停。也可以随时点击步骤。';
  }

  function pauseStory() {
    playing = false;
    clearTimeout(storyTimer);
    renderPlayback();
  }

  async function showStoryStep(step, autoplay = false) {
    const request = ++storyRequest;
    const data = storySteps[step];
    storyScreen.setAttribute('aria-busy', 'true');
    try {
      if (data.source) await prepareImage(data.source);
      if (request !== storyRequest || (autoplay && (!playing || !playbackAllowed()))) return false;
      if (data.source) {
        storyImage.src = data.source;
        storyImage.alt = data.alt;
        storyScreenshot.dataset.imageTitle = data.title;
        storyScreenshot.setAttribute('aria-label', `放大查看${data.title}截图`);
      }
      storyChat.hidden = step !== 0;
      storyScreenshot.hidden = step === 0;
      storyStep = step;
      story.dataset.stage = String(step);
      storyStatus.textContent = data.status;
      storyButtons.forEach(button => button.setAttribute('aria-pressed', String(Number(button.dataset.storyStep) === step)));
      if (data.source) await storyImage.decode();
      if (request !== storyRequest) return false;
      window.dispatchEvent(new CustomEvent('guzi:story-change', { detail: { step, image: step === 0 ? null : storyImage } }));
      return true;
    } catch {
      if (request === storyRequest) {
        storyStatus.textContent = '截图暂时无法加载，请稍后再试。';
        pauseStory();
      }
      return false;
    } finally {
      if (request === storyRequest) storyScreen.removeAttribute('aria-busy');
    }
  }

  function scheduleStoryStep() {
    clearTimeout(storyTimer);
    if (!playing) return;
    storyTimer = setTimeout(async () => {
      if (!playbackAllowed() || storyStep === storySteps.length - 1) return pauseStory();
      const changed = await showStoryStep(storyStep + 1, true);
      if (!changed || storyStep === storySteps.length - 1) pauseStory();
      else scheduleStoryStep();
    }, 5000);
  }

  storyButtons.forEach(button => button.addEventListener('click', () => {
    pauseStory();
    showStoryStep(Number(button.dataset.storyStep));
  }));
  playButton.addEventListener('click', async () => {
    if (playing) return pauseStory();
    if (!playbackAllowed()) return;
    if (storyStep === storySteps.length - 1 && !await showStoryStep(0)) return;
    if (!playbackAllowed()) return;
    playing = true;
    renderPlayback();
    scheduleStoryStep();
  });
  replayButton.addEventListener('click', () => {
    pauseStory();
    showStoryStep(0);
  });
  function updateStoryPlayback() {
    if (!playbackAllowed()) pauseStory();
    else renderPlayback();
  }
  new IntersectionObserver(entries => {
    storyVisible = entries[0].isIntersecting;
    updateStoryPlayback();
  }, { threshold: 0.1 }).observe(story);
  document.addEventListener('visibilitychange', updateStoryPlayback);
  window.addEventListener('guzi:motion', updateStoryPlayback);
  motionQuery.addEventListener('change', updateStoryPlayback);
  new MutationObserver(updateStoryPlayback).observe(document.documentElement, { attributes: true, attributeFilter: ['data-motion'] });
  document.querySelector('.story-controls').hidden = false;
  renderPlayback();

  const plugins = {
    routine: {
      label: '作息插件',
      title: '给一天，留出自己的节奏。',
      description: '用时间块安排学习、工作和休息，把顺手的一天存成模板。',
    },
    focus: {
      label: '专注插件',
      title: '现在，只专心做这一件。',
      description: '开启一轮番茄钟，让专注和休息各有时间，也看见自己的投入。',
    },
    habit: {
      label: '打卡插件',
      title: '小小的坚持，也值得被记住。',
      description: '给自己的小目标打个卡，看看连续天数和这段时间走过的路。',
    },
    achievement: {
      label: '成就插件',
      title: '把走过的路，收进成就里。',
      description: '完成任务、持续专注、坚持打卡。让长期积累变成看得见的收藏。',
    },
    notebook: {
      label: '记事本插件',
      title: '随手想到的，留个地方放。',
      description: '用 Markdown 记笔记，按分类和标签整理，也能把日报存下来接着写。',
    },
  };
  const pluginButtons = [...document.querySelectorAll('[data-plugin]')];
  const pluginTitle = document.querySelector('#plugin-title');
  const pluginDescription = document.querySelector('#plugin-description');
  const pluginPreview = document.querySelector('#plugin-preview');
  const pluginImage = document.querySelector('#plugin-image');
  let pluginRequest = 0;

  async function selectPlugin(name, updateURL = false) {
    const request = ++pluginRequest;
    const plugin = plugins[name];
    const source = `assets/plugin-${name}.jpg`;
    pluginPreview.setAttribute('aria-busy', 'true');
    try {
      await prepareImage(source);
      if (request !== pluginRequest) return;
      pluginButtons.forEach(button => button.setAttribute('aria-pressed', String(button.dataset.plugin === name)));
      pluginTitle.textContent = plugin.title;
      pluginDescription.textContent = plugin.description;
      pluginImage.src = source;
      pluginImage.alt = `谷子助手${plugin.label}的实际应用界面，内容为演示数据`;
      pluginPreview.dataset.imageTitle = plugin.label;
      pluginPreview.setAttribute('aria-label', `放大查看${plugin.label}实际界面`);
      if (updateURL) {
        const url = new URL(location.href);
        url.searchParams.set('plugin', name);
        history.replaceState(null, '', url);
      }
      await pluginImage.decode();
      if (request !== pluginRequest) return;
      window.dispatchEvent(new CustomEvent('guzi:plugin-change', { detail: { name, image: pluginImage } }));
    } catch {
      if (request === pluginRequest) pluginDescription.textContent = '截图暂时无法加载，请稍后再次选择。';
    } finally {
      if (request === pluginRequest) pluginPreview.removeAttribute('aria-busy');
    }
  }

  pluginButtons.forEach(button => button.addEventListener('click', () => selectPlugin(button.dataset.plugin, true)));
  const initialPlugin = new URL(location.href).searchParams.get('plugin');
  selectPlugin(Object.hasOwn(plugins, initialPlugin) ? initialPlugin : 'routine');
  window.addEventListener('popstate', () => {
    const name = new URL(location.href).searchParams.get('plugin');
    selectPlugin(Object.hasOwn(plugins, name) ? name : 'routine');
  });
})();
