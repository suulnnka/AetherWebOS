/* ============================================================
 * AppFS —— 应用级虚拟文件系统 API
 *
 * 每个应用窗口挂载时绑定一个「执行用户」(execution user):
 *   · 默认 executeAs: 'session' → 打开窗口时的登录用户
 *   · 清单可写 executeAs: 'root' | 固定用户名(系统应用预留)
 *
 * 应用通过 ctx.fs 拿到的不是全局 fs,而是本模块 createAppFs() 的实例:
 * 所有读/写/建/删/改权限检查都以执行用户身份进行(as: execUser),
 * 与会话用户是否后来切换无关。新建文件默认属主 = 执行用户。
 *
 * 未登录(执行用户为 null)时写操作失败、读按无权限处理。
 * ============================================================ */
import fs, { homePath, desktopPath, normPath, basename, parentPath, joinPath } from './fs.js';

/**
 * 创建绑定执行用户的应用 FS。
 * @param {string} appId  应用 ID(诊断用)
 * @param {string|null} user 执行用户;null = 无权限主体
 */
export function createAppFs(appId, user) {
  const opts = () => ({ as: user });

  const api = {
    appId,
    /** 本应用的执行用户(打开窗口时绑定,不随会话切换漂移) */
    user,

    /* ---- 路径 ---- */
    normPath, basename, parentPath, joinPath,
    /** 执行用户家目录 /home/<user>(未登录 null) */
    homePath: () => homePath(user),
    /** 执行用户桌面 ~/desktop */
    desktopPath: () => desktopPath(user),

    /* ---- 查询 ---- */
    /** 路径是否存在(需能穿越父目录) */
    exists(p) {
      if (!fs.exists(p)) return false;
      if (user === 'root') return true;
      return fs.canTraverse(p, user);
    },
    isDir(p) {
      if (!fs.isDir(p)) return false;
      return api.exists(p) && fs.can(p, 'r', user);
    },
    /** 元数据;不存在或无法穿越 → null */
    stat(p) {
      if (!api.exists(p)) return null;
      return fs.stat(p);
    },
    /** 列目录;无读权限返回 null */
    list(p) { return fs.list(p, opts()); },

    /* ---- 读 ---- */
    /** 读文件内容;不存在或无读权限 → null */
    read(p) { return fs.read(p, opts()); },

    /* ---- 写 / 新建 ---- */
    /**
     * 写文件(父目录可自动创建,需父目录可写)。
     * 新建属主 = 执行用户;已有文件需对该文件有写权限。
     * @returns {boolean}
     */
    write(p, content, extra = {}) {
      if (!user) return false;
      return fs.write(p, content, {
        ...opts(),
        owner: extra.owner || user,
        mode: extra.mode,
      });
    },
    /** 创建目录(可递归);父目录需可写 */
    mkdir(p, { silent } = {}) {
      if (!user) return null;
      return fs.mkdir(p, { ...opts(), silent });
    },
    /** 新建空文件(write 的便捷封装) */
    create(p, content = '') {
      return api.write(p, content);
    },

    /* ---- 删 / 改名 ---- */
    /** 删除文件或目录(递归);需父目录可写,且对目标有写权限 */
    rm(p) {
      if (!user) return false;
      return fs.rm(p, opts());
    },
    /** 移动 / 重命名;源与目标父目录均需可写 */
    rename(oldP, newP) {
      if (!user) return false;
      return fs.rename(oldP, newP, opts());
    },

    /* ---- 权限 ---- */
    /** 是否允许执行用户对 path 做 r/w/x */
    can(p, bit) { return fs.can(p, bit, user); },
    /** chmod:仅执行用户为属主或 root 时成功 */
    chmod(p, mode) {
      if (!user) return false;
      return fs.chmod(p, mode, opts());
    },
    /** chown:仅 root 执行身份 */
    chown(p, newOwner) {
      if (user !== 'root') return false;
      return fs.chown(p, newOwner, opts());
    },

    /* ---- 其它 ---- */
    /** 全盘统计(系统信息,不受目录权限裁剪) */
    stats() { return fs.stats(); },
    /** 路径工具与核心一致 */
    ensureUserHome: (u) => fs.ensureUserHome(u),
  };

  return api;
}

export default createAppFs;
