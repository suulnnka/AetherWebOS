/* 设置应用单元字典(P0 先覆盖「系统」节的界面语言行;其余分区文案随 P2 全量接入补齐)。
 * 中文即键(docs/i18n.md §4):键 = 源码里 t('…') 的中文字面量原文,
 * zh 用户不加载本文件(core/system/lib 由 boot 期 en 动态 import)。 */
import { registerDict } from '../../../core/i18n.js';

registerDict('en', {
  '界面语言': 'Interface language',
  '切换界面语言后需要重启系统才会生效': 'Switching the interface language takes effect after a system restart',
  '跟随浏览器': 'Follow browser',
  '简体中文': '简体中文',
  '切换界面语言': 'Switch interface language',
  '要立即重启系统以应用新的界面语言吗?': 'Restart the system now to apply the new interface language?',
  '立即重启': 'Restart now',
  '暂不重启': 'Not now',
});
