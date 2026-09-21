/* ============ 应用:系统设置 ============ */
import { el, fmtDate, formatBytes } from '../../core/utils.js';
import { icon } from '../../core/icons.js';
import { register } from '../../core/registry.js';
import manifest from './manifest.js';
import './settings.css';
import { settings, ACCENTS, STATIC_WALLPAPERS, DYNAMIC_WALLPAPERS, pickWallpaper, STYLES } from '../../core/store.js';
import { subscribe } from '../../core/bus.js';
import { accounts } from '../../core/accounts.js';
import { logoutSession } from '../../system/session.js';
import { beep } from '../../core/audio.js';
import { modal } from '../../core/ui.js';
import fs from '../../core/fs.js';
import { forApp } from '../../core/dialogs.js';
import { openConfigPopup, openGamePopup } from './popup-demo.js';

/* 应用内弹框走应用绑定实例(与 mount ctx 的 ctx.dialogs 完全同语义):
 * 默认二级 · 应用模态,owner=settings,只锁设置自己的窗口;
 * renderSection 是模块级函数拿不到 ctx,故在此绑定。个别调用点
 * 仍可用 { level: 1 / 3 } 显式覆盖(见弹框分级演示按钮)。 */
const dialogs = forApp('settings');

const SECTIONS = [
  { id: 'appearance', name: '外观', icon: 'palette' },
  { id: 'wallpaper', name: '壁纸', icon: 'image' },
  { id: 'desktop', name: '桌面与任务栏', icon: 'monitor' },
  { id: 'sound', name: '声音', icon: 'volume2' },
  { id: 'display', name: '显示', icon: 'sun' },
  { id: 'user', name: '用户', icon: 'user' },
  { id: 'system', name: '系统', icon: 'info' },
];

function row(label, desc, control) {
  return el('div', { class: 'set-row' },
    el('div', {},
      el('div', { class: 's-label' }, label),
      desc ? el('div', { class: 's-desc' }, desc) : null),
    el('div', { class: 'row' }, control));
}

/** 开关 */
function switchBox(get, set) {
  const input = el('input', { type: 'checkbox' });
  input.checked = !!get();
  input.addEventListener('change', () => set(input.checked));
  return el('label', { class: 'switch' }, input, el('i'));
}

/** 滑杆(带数值) */
function slider(min, max, get, set, unit = '') {
  const paint = (r) => { r.style.setProperty('--fill', ((r.value - min) / (max - min) * 100) + '%'); };
  const range = el('input', { type: 'range', min, max, value: get() });
  paint(range);
  range.addEventListener('input', () => { paint(range); set(+range.value); });
  return range;
}

function renderSection(root, sec, bus) {
  root.innerHTML = '';
  const s = settings.get();
  const title = el('div', { class: 'sec-title' }, SECTIONS.find(x => x.id === sec)?.name || '');

  if (sec === 'appearance') {
    const themeSeg = el('div', { class: 'seg' },
      ...[['light', '浅色'], ['dark', '深色'], ['auto', '跟随系统']].map(([v, name]) =>
        el('button', {
          class: 'seg-btn' + (s.theme === v ? ' active' : ''),
          onClick: (e) => { settings.set({ theme: v }); [...themeSeg.children].forEach(b => b.classList.remove('active')); e.currentTarget.classList.add('active'); },
        }, name)));

    /** 风格主题选择器(迷你预览卡) */
    const styleCards = el('div', { class: 'style-cards' },
      ...STYLES.map(st => el('button', {
        class: 'style-card' + (s.style === st.id ? ' selected' : ''),
        dataset: { sty: st.id },
        onClick: (e) => {
          settings.set({ style: st.id });
          bus.notify('风格已切换', st.name);
          renderSection(root, 'appearance', bus);
        },
      },
        el('span', { class: 'sp' },
          el('span', { class: 'sp-win' },
            el('span', { class: 'sp-bar' },
              el('i', { class: 'sp-dot d1' }), el('i', { class: 'sp-dot d2' }), el('i', { class: 'sp-dot d3' }))),
          el('span', { class: 'sp-task' }, el('i', { class: 'sp-start' }))),
        el('span', { class: 'sty-name' }, st.name))));

    root.append(el('div', { class: 'set-body' }, title,
      row('风格主题', '整套系统皮肤:窗体、任务栏、开始菜单、按钮全部跟随', styleCards),
      row('主题模式', '深色 / 浅色界面风格,可跟随系统的显示设置', themeSeg),
      row('强调色', '应用于按钮、开关、选中态等控件', el('div', { class: 'swatches' },
        ...ACCENTS.map(c => el('button', {
          class: 'swatch' + (s.accent === c ? ' selected' : ''),
          style: { background: c },
          title: c,
          onClick: (e) => {
            settings.set({ accent: c });
            [...e.currentTarget.parentElement.children].forEach(x => x.classList.remove('selected'));
            e.currentTarget.classList.add('selected');
          },
        })))),
      row('界面动效', '关闭后停用窗口与菜单动画,界面响应更快', switchBox(() => s.effects, v => settings.set({ effects: v }))),
    ));
  }

  else if (sec === 'wallpaper') {
    /** 壁纸缩略图网格:动态与静态是两组独立选择,各自记住选中项 */
    const thumbGrid = (list, kind) => {
      const chosen = kind === 'dynamic' ? s.wallpaperDynamic : s.wallpaperStatic;
      return el('div', { class: 'wp-grid' },
        ...list.map(wp => el('button', {
          class: 'wp-thumb' + (kind === 'dynamic' ? ' wp-dyn' : '') + (chosen === wp.id ? ' selected' : ''),
          style: { background: wp.css, backgroundSize: kind === 'dynamic' ? '220% 220%' : 'cover' },
          title: (kind === 'dynamic' ? '动态壁纸 · ' : '静态壁纸 · ') + wp.name,
          onClick: () => {
            pickWallpaper(wp.id);   // 选中并立即切换到该类型
            bus.notify('壁纸已更换', wp.name);
            renderSection(root, 'wallpaper', bus);
          },
        }, el('span', { class: 'wp-name' }, wp.name),
           kind === 'dynamic' ? el('span', { class: 'wp-tag' }, '动态') : null)));
    };

    const typeSeg = el('div', { class: 'seg' },
      ...[['static', '静态壁纸'], ['dynamic', '动态壁纸']].map(([v, name]) =>
        el('button', {
          class: 'seg-btn' + (s.wallpaperType === v ? ' active' : ''),
          onClick: () => {
            settings.set({ wallpaperType: v });
            renderSection(root, 'wallpaper', bus);
          },
        }, name)));

    const usingTag = (type) => s.wallpaperType === type ? el('span', { class: 'f-now' }, '使用中') : null;

    const urlInput = el('input', {
      class: 'input', placeholder: '粘贴图片 URL…',
      value: s.wallpaperStatic === 'custom' ? s.wallpaperUrl : '', style: { flex: '1' },
    });
    const applyUrl = () => {
      const v = urlInput.value.trim();
      if (!v) return;
      settings.set({ wallpaperType: 'static', wallpaperStatic: 'custom', wallpaperUrl: v });
      bus.notify('壁纸已更换', '自定义图片');
      renderSection(root, 'wallpaper', bus);
    };
    urlInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') applyUrl(); });

    const fileInput = el('input', { type: 'file', accept: 'image/*', style: { display: 'none' } });
    fileInput.addEventListener('change', () => {
      const f = fileInput.files[0];
      if (!f) return;
      if (f.size > 2.5 * 1024 * 1024) { bus.notify('图片过大', '建议小于 2.5MB,以免超出浏览器存储上限'); return; }
      const r = new FileReader();
      r.onload = () => {
        settings.set({ wallpaperType: 'static', wallpaperStatic: 'custom', wallpaperUrl: String(r.result) });
        bus.notify('壁纸已更换', f.name);
        renderSection(root, 'wallpaper', bus);
      };
      r.readAsDataURL(f);
    });

    root.append(el('div', { class: 'set-body' }, title,
      row('壁纸类型', '静态与动态分开选择、各自记住;点任一缩略图立即换上,顶部可在两组之间切换', typeSeg),
      el('div', { class: 'field' },
        el('div', { class: 'f-label' }, '动态壁纸', usingTag('dynamic')),
        thumbGrid(DYNAMIC_WALLPAPERS, 'dynamic'),
        el('div', { class: 'f-desc' }, '画面持续缓慢流动,选中的同时会切换到动态模式。')),
      el('div', { class: 'field' },
        el('div', { class: 'f-label' }, '静态壁纸', usingTag('static')),
        thumbGrid(STATIC_WALLPAPERS, 'static')),
      el('div', { class: 'field' },
        el('div', { class: 'f-label' }, '自定义壁纸(静态)'),
        el('div', { class: 'row' },
          urlInput,
          el('button', { class: 'btn', onClick: applyUrl }, '应用'),
          el('button', { class: 'btn', onClick: () => fileInput.click() }, icon('image', 14), '上传'),
          fileInput),
        el('div', { class: 'f-desc' }, '上传的图片会以 DataURL 形式保存在浏览器本地存储中,属于静态壁纸。')),
    ));
  }

  else if (sec === 'desktop') {
    const seg = el('div', { class: 'seg' },
      ...[['small', '小'], ['medium', '中'], ['large', '大']].map(([v, name]) =>
        el('button', {
          class: 'seg-btn' + (s.iconSize === v ? ' active' : ''),
          onClick: (e) => {
            settings.set({ iconSize: v });
            [...seg.children].forEach(b => b.classList.remove('active'));
            e.currentTarget.classList.add('active');
          },
        }, name)));
    root.append(el('div', { class: 'set-body' }, title,
      row('桌面图标大小', '调整桌面与开始菜单中应用磁贴的尺寸', seg),
      row('时钟显示秒', '任务栏右侧时间显示到秒', switchBox(() => s.clockSeconds, v => settings.set({ clockSeconds: v }))),
    ));
  }

  else if (sec === 'sound') {
    const volSlider = slider(0, 100, () => s.volume, v => settings.set({ volume: v }));
    root.append(el('div', { class: 'set-body' }, title,
      row('系统音量', '所有应用播放的声音共用此音量(试试测试音)', volSlider),
      row('静音', '临时关闭所有声音', switchBox(() => s.muted, v => settings.set({ muted: v }))),
      row('测试音', '以当前音量播放一段提示音', el('button', {
        class: 'btn',
        onClick: () => { beep(660, 0.18); setTimeout(() => beep(880, 0.22), 200); },
      }, icon('play', 13), '播放')),
    ));
  }

  else if (sec === 'display') {
    root.append(el('div', { class: 'set-body' }, title,
      row('屏幕亮度', '通过亮度遮罩模拟,不影响耗电', slider(30, 100, () => s.brightness, v => settings.set({ brightness: v }))),
      row('当前分辨率', '', el('span', { class: 'dim mono' }, `${screen.width} × ${screen.height}`)),
    ));
  }

  else if (sec === 'user') {
    const cur = accounts.current();

    // ---- 当前会话 ----
    const sessBtn = el('button', { class: 'btn' }, cur ? '注销' : '登录 / 切换用户');
    sessBtn.addEventListener('click', () => logoutSession());   // 注销会关闭所有窗口(含本设置)
    const sessionRow = el('div', { class: 'user-row', style: { marginBottom: '10px' } },
      el('span', { class: 'ss-avatar' }, ((cur ? accounts.displayName() : s.username)[0] || 'A').toUpperCase()),
      el('div', { style: { flex: 1 } },
        el('div', { class: 'u-name' }, cur ? (accounts.displayName() || cur) : '未登录'),
        el('div', { class: 'u-meta' }, cur ? `账号 ${cur} · 会话已持久化,刷新后仍生效` : '登录后应用数据按账号隔离')),
      sessBtn);

    // ---- 显示名(仅登录时) ----
    let nameRow;
    if (cur) {
      const input = el('input', { class: 'input', value: accounts.displayName() || cur, style: { width: '160px' } });
      input.addEventListener('change', () => {
        const r = accounts.setDisplayName(cur, input.value);
        bus.notify(r.ok ? '显示名已更新' : '修改失败', r.ok ? r.displayName : (r.error || ''));
      });
      nameRow = row('显示名', '显示在开始菜单左下角与注销锁屏中', input);
    } else {
      nameRow = row('显示名', '登录后可修改', el('span', { class: 'dim' }, '未登录'));
    }

    // ---- 系统用户列表 ----
    const listWrap = el('div', { class: 'user-list' });
    const redrawList = () => {
      listWrap.innerHTML = '';
      const users = accounts.list();
      for (const u of users) {
        const del = el('button', { class: 'btn danger', title: `删除用户 ${u.name}`, style: { flex: 'none' } }, icon('trash', 13));
        del.addEventListener('click', async () => {
          const pw = await dialogs.prompt({
            title: `删除用户 ${u.name}`,
            message: '删除后该用户的应用数据将无法再访问。输入该用户的密码以确认。',
            placeholder: '密码', okText: '删除',
          });
          if (pw == null || !pw) return;
          const r = await accounts.remove(u.name, pw);
          if (!r.ok) { bus.notify('删除失败', r.error); return; }
          bus.notify('用户已删除', u.name + (r.wasCurrent ? '(已注销)' : ''));
          redrawList();
        });
        listWrap.append(el('div', { class: 'user-row' },
          el('span', { class: 'ss-avatar' }, (u.displayName[0] || '?').toUpperCase()),
          el('div', { style: { flex: 1, minWidth: 0 } },
            el('div', { class: 'u-name' }, u.displayName),
            el('div', { class: 'u-meta' }, `@${u.name} · 创建于 ${fmtDate(new Date(u.created))}`)),
          u.name === cur ? el('span', { class: 'dim', style: { fontSize: '11px', flex: 'none' } }, '当前') : null,
          del));
      }
      if (!users.length) listWrap.append(el('div', { class: 'dim', style: { fontSize: '12px', padding: '4px 2px' } }, '暂无用户,可在下方创建'));
    };
    redrawList();

    // ---- 添加用户 ----
    const newName = el('input', { class: 'input', placeholder: '用户名', style: { width: '120px' } });
    const newPass = el('input', { class: 'input', type: 'password', placeholder: '密码', style: { width: '120px' } });
    const addBtn = el('button', { class: 'btn primary', style: { flex: 'none' } }, '添加');
    addBtn.addEventListener('click', async () => {
      addBtn.disabled = true;
      try {
        const r = await accounts.createUser(newName.value, newPass.value);
        if (!r.ok) { bus.notify('创建失败', r.error); return; }
        bus.notify('用户已创建', r.user);
        newName.value = newPass.value = '';
        redrawList();
      } finally { addBtn.disabled = false; }
    });

    root.append(el('div', { class: 'set-body' }, title,
      row('当前会话', '', sessionRow),
      nameRow,
      row('系统用户', '注销后可在此处列出的用户之间切换登录', listWrap),
      row('添加用户', '仅创建账号,不切换当前登录', el('div', { class: 'row' }, newName, newPass, addBtn)),
      row('用户目录', '', el('span', { class: 'dim mono' }, '/home')),
    ));
  }

  else if (sec === 'system') {
    const stats = fsStats();
    root.append(el('div', { class: 'set-body' }, title,
      el('div', { class: 'card', style: { marginBottom: '16px' } },
        el('div', { class: 'card-title' }, icon('info', 15), '关于本系统'),
        el('div', { class: 'row', style: { justifyContent: 'space-between', padding: '4px 0' } }, '系统名称', el('b', {}, 'WebOS')),
        el('div', { class: 'row', style: { justifyContent: 'space-between', padding: '4px 0' } }, '版本', el('span', { class: 'mono' }, '1.0.0')),
        el('div', { class: 'row', style: { justifyContent: 'space-between', padding: '4px 0' } }, '技术栈', el('span', { class: 'dim' }, '原生 ES Modules · npm 依赖随构建打包 · 无后端')),
        el('div', { class: 'row', style: { justifyContent: 'space-between', padding: '4px 0' } }, '内核类型', el('span', { class: 'dim mono' }, navigator.userAgent.includes('Firefox') ? 'Gecko' : 'Chromium')),
      ),
      el('div', { class: 'card', style: { marginBottom: '16px' } },
        el('div', { class: 'card-title' }, icon('hardDrive', 15), '本地存储'),
        el('div', { class: 'dim', style: { fontSize: '12px' } },
          `文件 ${stats.files} 个 · 目录 ${stats.dirs} 个 · 内容 ${formatBytes(stats.bytes)}`),
        el('div', { class: 'usage-bar' }, el('i', { style: { width: storagePercent() + '%' } })),
        el('div', { class: 'dim', style: { fontSize: '11.5px', marginTop: '6px' } },
          `localStorage 已用 ${formatBytes(localStorageUsage())} / 约 5MB`),
      ),
      row('系统对话框', '内置的模态对话框集合(错误/警告/确认/输入/进度等)',
        el('div', { class: 'row', style: { flexWrap: 'wrap', justifyContent: 'flex-end' } },
          el('button', { class: 'btn', onClick: () => dialogs.info({ title: '提示', message: '这是一条信息对话框。' }) }, '信息'),
          el('button', { class: 'btn', onClick: () => dialogs.warning({ title: '警告', message: '存储空间即将耗尽。' }) }, '警告'),
          el('button', { class: 'btn', onClick: () => dialogs.error({ title: '错误', message: '操作失败:', detail: 'E_ACCESS_DENIED (0x5)\n演示于 系统设置 → 系统' }) }, '错误'),
          el('button', { class: 'btn', onClick: async () => { const ok = await dialogs.confirm({ title: '确认操作', message: '要继续这个演示吗?' }); dialogs.info({ title: '结果', message: `你选择了:${ok ? '确定' : '取消'}` }); } }, '确认'),
          el('button', { class: 'btn', onClick: async () => { const v = await dialogs.prompt({ title: '输入', message: '随便输入点什么:' }); if (v != null) dialogs.success({ title: '收到', message: `你输入了:「${v}」` }); } }, '输入'),
          el('button', { class: 'btn', onClick: () => { const h = dialogs.progress({ title: '系统自检' }); let v = 0; const t = setInterval(() => { v += 12; if (v >= 100) { clearInterval(t); h.done('自检完成,一切正常'); } else h.set(v, `检查模块 ${v}%`); }, 260); } }, '进度'))),
      row('弹框分级', '一级:不影响任何操作;二级:锁定本应用所有窗口,其他照常;三级:整个系统锁定直至关闭',
        el('div', { class: 'row', style: { flexWrap: 'wrap', justifyContent: 'flex-end' } },
          el('button', { class: 'btn', onClick: () => dialogs.confirm({ level: 1, owner: 'settings', title: '一级弹框 · 非模态', message: '我不影响任何操作。', detail: '可以照常操作其他窗口、任务栏,甚至本窗口,我只是浮在这里。' }) }, '一级'),
          el('button', { class: 'btn', onClick: () => dialogs.confirm({ level: 2, owner: 'settings', title: '二级弹框 · 应用模态', message: '系统设置的所有窗口已被我锁定。', detail: '其他应用、任务栏、桌面照常可用——去开个计算器试试。' }) }, '二级'),
          el('button', { class: 'btn', onClick: () => dialogs.confirm({ level: 3, title: '三级弹框 · 系统模态', message: '整个系统都已锁定。', detail: '处理完这个弹框之前,哪儿也去不了。' }) }, '三级'))),
      row('复杂弹窗', '弹窗 ≠ 消息框:内容可以是复杂配置页,甚至是真正渲染的游戏',
        el('div', { class: 'row', style: { flexWrap: 'wrap', justifyContent: 'flex-end' } },
          el('button', {
            class: 'btn',
            onClick: async () => {
              const result = await openConfigPopup();
              if (result) dialogs.success({ level: 1, title: '配置已保存', message: `画质 ${result.quality} · FOV ${result.fov}° · 预算 ${result.budget}%` });
            },
          }, '配置弹窗(二级)'),
          el('button', {
            class: 'btn',
            onClick: async () => {
              const result = await openGamePopup();
              if (result !== undefined) dialogs.info({ level: 1, title: '游戏结束', message: result ? '通关!五颗弹珠全部接住 🎉' : '再接再厉,下次一定。' });
            },
          }, '游戏弹窗(三级)'))),
      row('完全重置此电脑', '删除浏览器中保存的一切数据:设置、文件、用户账号与各应用数据全部清空,恢复到刚安装时的初始状态(不可恢复)',
        el('button', {
          class: 'btn danger',
          onClick: async () => {
            const ok = await modal(root, {
              title: '完全重置此电脑', danger: true, confirmText: '删掉一切,重置',
              body: '此操作将删除此电脑上的全部内容:所有设置、文件、用户账号与应用数据都会被永久清除,无法恢复。系统随后会恢复初始状态并重新启动。确定继续吗?',
            });
            if (ok) settings.reset();
          },
        }, icon('trash', 13), '完全重置')),
    ));
  }
}

function localStorageUsage() {
  let n = 0;
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    n += k.length + (localStorage.getItem(k) || '').length;
  }
  return n * 2; // UTF-16
}
const storagePercent = () => Math.min(100, Math.round(localStorageUsage() / (5 * 1024 * 1024) * 100));

function fsStats() {
  return fs.stats();
}

register({
  ...manifest,
  mount({ root, bus, params }) {
    let current = params.section || 'appearance';
    const navBox = el('div', { class: 'app-side' });
    const content = el('div', { class: 'app-body', style: { userSelect: 'text' } });

    function renderNav() {
      navBox.innerHTML = '';
      for (const sec of SECTIONS) {
        navBox.append(el('button', {
          class: 'nav-item' + (sec.id === current ? ' active' : ''),
          onClick: () => { current = sec.id; renderNav(); renderSection(content, current, bus); },
        }, el('span', { class: 'ni' }, icon(sec.icon, 15)), sec.name));
      }
    }

    renderNav();
    renderSection(content, current, bus);

    root.append(el('div', { class: 'app' },
      el('div', { class: 'app-toolbar' }, el('b', { style: { fontSize: '13.5px' } }, '系统设置'), el('span', { class: 'grow' }),
        el('span', { class: 'dim', style: { fontSize: '12px' } }, fmtDate(new Date(), true))),
      el('div', { class: 'app-mid' }, navBox, content)));

    // 其他应用可以请求设置应用跳转分区,例如终端: open settings --section wallpaper
    const off = bus.on('params', (p) => {
      if (p?.section && SECTIONS.some(s => s.id === p.section)) {
        current = p.section;
        renderNav();
        renderSection(content, current, bus);
      }
    });
    // 壁纸外部变化时刷新预览选中态
    const off2 = subscribe('sys:settings-changed', (p) => {
      if (p?.changed?.some(k => ['wallpaperType', 'wallpaperStatic', 'wallpaperDynamic', 'wallpaperUrl'].includes(k))) renderSection(content, current, bus);
    });

    return {
      onClose() { off(); off2(); return true; },
    };
  },
});
