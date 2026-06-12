/* ============================================================
 * 次元大战(多人版) - 共享游戏数据（服务端/客户端通用）
 * ============================================================ */
(function (root, factory) {
  const data = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = data;
  else Object.assign(root, data);
})(typeof self !== 'undefined' ? self : this, function () {

const DIMENSIONS = [
  {
    id: 'tech', name: '科技世界', icon: '⚙️', color: '#00a8ff',
    desc: '机甲轰鸣、量子计算与轨道武器的世界。降临者将获得纳米改造，以科技之力征服次元。',
    regions: [
      { name: '废弃实验室', tier: 1, monsters: ['巡逻机器人', '故障清扫机', '实验体X-01'] },
      { name: '机械城区',   tier: 2, monsters: ['失控机甲', '武装无人机', '钢铁猎犬'] },
      { name: '轨道空港',   tier: 3, monsters: ['空港守卫AI', '纳米兽群', '电浆炮台'] },
      { name: '量子核心',   tier: 4, monsters: ['量子幽灵', '天网执行者', '核心守护者·零'] },
    ],
    skills: [
      { name: '等离子射击', lvl: 1,  type: 'dmg',  mult: 1.5, cd: 2, desc: '发射高温等离子弹，造成150%伤害' },
      { name: '纳米修复',   lvl: 3,  type: 'heal', pct: 0.30, cd: 4, desc: '纳米机器人修复机体，恢复30%生命' },
      { name: '电磁脉冲',   lvl: 6,  type: 'stun', mult: 0.8, cd: 5, desc: '造成80%伤害并使敌人瘫痪1回合' },
      { name: '轨道炮打击', lvl: 10, type: 'dmg',  mult: 2.6, cd: 5, desc: '呼叫轨道炮，造成260%毁灭性伤害' },
      { name: '机甲降临',   lvl: 15, type: 'dmg',  mult: 3.8, cd: 7, desc: '召唤专属机甲践踏战场，造成380%伤害' },
    ],
    weaponNames: ['脉冲步枪', '光子刃', '磁轨炮'],
    armorNames:  ['纳米装甲', '动力外骨骼', '能量护盾'],
    accNames:    ['战术芯片', '量子核心', '瞄准模块'],
  },
  {
    id: 'xiuxian', name: '修仙世界', icon: '⚔️', color: '#2ecc71',
    desc: '灵气充盈、剑光纵横的东方仙侠世界。降临者将开启灵根，御剑飞行，问鼎大道。',
    regions: [
      { name: '青云山脚', tier: 1, monsters: ['妖狼', '赤目野猪', '草木傀儡'] },
      { name: '灵兽森林', tier: 2, monsters: ['白额灵虎', '尸傀', '噬灵藤妖'] },
      { name: '剑冢秘境', tier: 3, monsters: ['残剑剑灵', '守冢石人', '心魔幻影'] },
      { name: '九天雷池', tier: 4, monsters: ['紫雷兽', '渡劫狂蛟', '化神老魔'] },
    ],
    skills: [
      { name: '御剑术',   lvl: 1,  type: 'dmg',  mult: 1.5, cd: 2, desc: '飞剑出鞘，造成150%伤害' },
      { name: '回春诀',   lvl: 3,  type: 'heal', pct: 0.30, cd: 4, desc: '运转灵力疗伤，恢复30%生命' },
      { name: '定身符',   lvl: 6,  type: 'stun', mult: 0.8, cd: 5, desc: '造成80%伤害并定身敌人1回合' },
      { name: '剑气纵横', lvl: 10, type: 'dmg',  mult: 2.6, cd: 5, desc: '万千剑气倾泻，造成260%伤害' },
      { name: '飞升一击', lvl: 15, type: 'dmg',  mult: 3.8, cd: 7, desc: '引动天地灵气一剑破空，造成380%伤害' },
    ],
    weaponNames: ['青锋剑', '诛仙古剑', '紫雷飞剑'],
    armorNames:  ['云纹道袍', '玄龟甲衣', '九天霞衣'],
    accNames:    ['聚灵珠', '护心镜', '乾坤玉佩'],
  },
  {
    id: 'cyber', name: '赛博朋克世界', icon: '🌃', color: '#e84393',
    desc: '霓虹闪烁、义体横行的高科技低生活都市。降临者将植入军用义体，在暗巷与高塔间生存。',
    regions: [
      { name: '霓虹贫民窟', tier: 1, monsters: ['街头混混', '废品机器人', '电子瘾者'] },
      { name: '黑市街区',   tier: 2, monsters: ['改造杀手', '黑市保镖', '猎尸人'] },
      { name: '企业高塔',   tier: 3, monsters: ['企业安保武装', '战斗义体人', '清道夫小队'] },
      { name: '网络深渊',   tier: 4, monsters: ['黑客幽灵', '防火墙巨像', '公司主脑'] },
    ],
    skills: [
      { name: '单分子刀',   lvl: 1,  type: 'dmg',  mult: 1.5, cd: 2, desc: '单分子利刃切割，造成150%伤害' },
      { name: '战斗兴奋剂', lvl: 3,  type: 'heal', pct: 0.30, cd: 4, desc: '注射军用药剂，恢复30%生命' },
      { name: '系统入侵',   lvl: 6,  type: 'stun', mult: 0.8, cd: 5, desc: '黑入敌人系统，造成80%伤害并瘫痪1回合' },
      { name: '智能狙击',   lvl: 10, type: 'dmg',  mult: 2.6, cd: 5, desc: '智能子弹锁定要害，造成260%伤害' },
      { name: '义体超频',   lvl: 15, type: 'dmg',  mult: 3.8, cd: 7, desc: '义体瞬间超频爆发，造成380%伤害' },
    ],
    weaponNames: ['智能手枪', '热能武士刀', '电磁霰弹枪'],
    armorNames:  ['防弹夹克', '皮下装甲', '军用义体'],
    accNames:    ['神经芯片', '光学迷彩', '反射增幅器'],
  },
  {
    id: 'magic', name: '西方魔法世界', icon: '🔮', color: '#9b59b6',
    desc: '巨龙翱翔、魔法璀璨的剑与魔法世界。降临者将觉醒魔力，习得禁咒，讨伐魔物。',
    regions: [
      { name: '边境郊野', tier: 1, monsters: ['哥布林', '野蛮半兽人', '腐烂史莱姆'] },
      { name: '黑暗森林', tier: 2, monsters: ['骷髅兵', '暗影狼群', '树妖长老'] },
      { name: '巨龙山脉', tier: 3, monsters: ['黑暗骑士', '双足飞龙', '石像鬼'] },
      { name: '虚空裂隙', tier: 4, monsters: ['深渊恶魔', '堕落大天使', '巫妖王'] },
    ],
    skills: [
      { name: '火球术',   lvl: 1,  type: 'dmg',  mult: 1.5, cd: 2, desc: '凝聚火元素轰击，造成150%伤害' },
      { name: '圣光治愈', lvl: 3,  type: 'heal', pct: 0.30, cd: 4, desc: '圣光洗礼，恢复30%生命' },
      { name: '冰霜禁锢', lvl: 6,  type: 'stun', mult: 0.8, cd: 5, desc: '造成80%伤害并冰冻敌人1回合' },
      { name: '陨石术',   lvl: 10, type: 'dmg',  mult: 2.6, cd: 5, desc: '召唤陨石坠落，造成260%伤害' },
      { name: '神罚禁咒', lvl: 15, type: 'dmg',  mult: 3.8, cd: 7, desc: '咏唱禁咒降下神罚，造成380%伤害' },
    ],
    weaponNames: ['法师杖', '圣银长剑', '龙骨魔杖'],
    armorNames:  ['秘银锁甲', '大魔导师袍', '龙鳞胸甲'],
    accNames:    ['魔力戒指', '贤者宝珠', '精灵护符'],
  },
  {
    id: 'hunter', name: '猎人世界', icon: '🎯', color: '#e67e22',
    desc: '念能力觉醒、危机四伏的猎人世界。降临者将通过猎人试炼，修炼念能力，狩猎万物。',
    regions: [
      { name: '试炼丛林',     tier: 1, monsters: ['变异蜂群', '狐熊', '沼泽拟态蛙'] },
      { name: '流星街',       tier: 2, monsters: ['盗贼团成员', '人偶操纵者', '改造暴徒'] },
      { name: '天空竞技场',   tier: 3, monsters: ['百战格斗家', '念兽守卫', '楼层主'] },
      { name: '暗黑大陆边缘', tier: 4, monsters: ['嵌合蚁士兵', '不死之病魔', '蚁王护卫'] },
    ],
    skills: [
      { name: '强化系重拳', lvl: 1,  type: 'dmg',  mult: 1.5, cd: 2, desc: '念力强化的一拳，造成150%伤害' },
      { name: '念力疗愈',   lvl: 3,  type: 'heal', pct: 0.30, cd: 4, desc: '念能力修复伤势，恢复30%生命' },
      { name: '缠丝束缚',   lvl: 6,  type: 'stun', mult: 0.8, cd: 5, desc: '念之丝线缠绕，造成80%伤害并束缚1回合' },
      { name: '圆之爆发',   lvl: 10, type: 'dmg',  mult: 2.6, cd: 5, desc: '全力释放念力领域，造成260%伤害' },
      { name: '王之一击',   lvl: 15, type: 'dmg',  mult: 3.8, cd: 7, desc: '倾尽生命的终极一击，造成380%伤害' },
    ],
    weaponNames: ['念能短刀', '具现化长鞭', '气化战斧'],
    armorNames:  ['强化护甲', '念丝织衣', '坚之外套'],
    accNames:    ['誓约徽章', '念力指环', '猎人执照'],
  },
];

const RARITIES = [
  { name: '普通', color: '#95a5a6', mult: 1.0,  weight: 50 },
  { name: '精良', color: '#2ecc71', mult: 1.35, weight: 28 },
  { name: '稀有', color: '#3498db', mult: 1.8,  weight: 14 },
  { name: '史诗', color: '#9b59b6', mult: 2.4,  weight: 6 },
  { name: '传说', color: '#f39c12', mult: 3.2,  weight: 2 },
];

const SLOTS = [
  { key: 'weapon', name: '武器', stat: 'atk' },
  { key: 'armor',  name: '防具', stat: 'def' },
  { key: 'acc',    name: '饰品', stat: 'hp'  },
];

/* 世界意志邀请奖励（按已邀请人数递进） */
const INVITE_REWARDS = [
  { gold: 200,  buff: 0.05, minRarity: 3, text: '世界意志注视着你：金币×200，史诗装备×1，全属性永久+5%' },
  { gold: 400,  buff: 0.05, minRarity: 3, text: '世界意志的嘉奖：金币×400，史诗装备×1，全属性永久+5%' },
  { gold: 800,  buff: 0.08, minRarity: 4, text: '世界意志的恩赐：金币×800，传说装备×1，全属性永久+8%' },
  { gold: 1500, buff: 0.10, minRarity: 4, text: '世界意志的祝福：金币×1500，传说装备×1，全属性永久+10%' },
];

/* Boss巢穴方位（弧度）：服务端刷T4怪与客户端巢穴装饰共用 */
const LAIR_ANGLES = { tech: 0.7, xiuxian: 2.2, cyber: 3.6, magic: 5.0, hunter: 1.4 };

return { DIMENSIONS, RARITIES, SLOTS, INVITE_REWARDS, LAIR_ANGLES };
});
