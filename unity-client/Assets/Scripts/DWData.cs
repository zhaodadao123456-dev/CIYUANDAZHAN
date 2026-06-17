/* ============================================================
 * 次元大战 Unity 客户端 - 静态数据
 * ⚠️ 与服务器 dimensional-war-3d/public/js/data.js 保持同步
 * ============================================================ */
using System.Collections.Generic;
using UnityEngine;

namespace DW
{
    public class SkillDef
    {
        public string key;     // basic/q/e/r
        public string name;
        public string kind;    // melee/proj/aoe/dashmelee/heal/aoeheal
        public string desc;
        public float cdMs;
        public int minLvl;
        // 与服务器一致的数值（用于「特效大小匹配范围」+「面板按技能等级显示实际威力」）
        public float mult;     // 伤害倍率（0=非伤害技）
        public float radius;   // aoe 半径 / 近战触及距离（米，用于特效尺寸与描述）
        public float pct;      // 治疗比例（0=非治疗技）
        public SkillDef(string key, string name, string kind, float cdMs, int minLvl, string desc,
                        float mult = 0f, float radius = 0f, float pct = 0f)
        { this.key = key; this.name = name; this.kind = kind; this.cdMs = cdMs; this.minLvl = minLvl; this.desc = desc;
          this.mult = mult; this.radius = radius; this.pct = pct; }
        // 服务器：伤害技 ×(1+0.18*(lvl-1))，治疗技 ×(1+0.15*(lvl-1))
        public float ScaleAt(int lvl) => 1f + (kind == "heal" || kind == "aoeheal" ? 0.15f : 0.18f) * (Mathf.Max(1, lvl) - 1);
    }

    public class ClassDef
    {
        public string id, name, role, icon;
        public float speed;
        public SkillDef[] skills;
        public SkillDef Skill(string key)
        {
            foreach (var s in skills) if (s.key == key) return s;
            return skills[0];
        }
    }

    public class DimDef
    {
        public string id, name, icon;
        public Color accent, ground, fog;
    }

    public static class Data
    {
        public const float MapHalf = 210f;   // 与服务器/网页版一致（大幅扩大）
        public const float LairR = 174f;
        static readonly Dictionary<string, float> LairAngles = new Dictionary<string, float>
        { { "tech", 0.7f }, { "xiuxian", 2.2f }, { "cyber", 3.6f }, { "magic", 5.0f }, { "hunter", 1.4f } };
        public static float LairAngle(string dimId) { float a; return LairAngles.TryGetValue(dimId, out a) ? a : 0f; }

        public static Color Hex(string h)
        {
            Color c = Color.white;
            ColorUtility.TryParseHtmlString(h, out c);
            return c;
        }

        public static readonly DimDef[] Dims =
        {
            new DimDef { id = "tech",    name = "科技世界",     icon = "⚙", accent = Hex("#00a8ff"), ground = Hex("#16263e"), fog = Hex("#0a1428") },
            new DimDef { id = "xiuxian", name = "修仙世界",     icon = "⚔", accent = Hex("#2ecc71"), ground = Hex("#163420"), fog = Hex("#0c2012") },
            new DimDef { id = "cyber",   name = "赛博朋克世界", icon = "🌃", accent = Hex("#e84393"), ground = Hex("#20122c"), fog = Hex("#140a1e") },
            new DimDef { id = "magic",   name = "西方魔法世界", icon = "🔮", accent = Hex("#9b59b6"), ground = Hex("#251840"), fog = Hex("#170e2a") },
            new DimDef { id = "hunter",  name = "猎人世界",     icon = "🎯", accent = Hex("#e67e22"), ground = Hex("#3a2a12"), fog = Hex("#261a0a") },
        };

        public static readonly DimDef WarDim = new DimDef
        { id = "war", name = "重叠战场", icon = "🌀", accent = Hex("#ff3355"), ground = Hex("#301020"), fog = Hex("#1c0a12") };

        public static DimDef Dim(string id)
        {
            if (id == "war") return WarDim;
            foreach (var d in Dims) if (d.id == id) return d;
            return Dims[0];
        }

        public static readonly ClassDef[] Classes =
        {
            new ClassDef { id = "warrior", name = "战士", role = "近战输出", icon = "⚔", speed = 8f, skills = new[] {
                new SkillDef("basic", "劈砍",   "melee",     600,   0, "挥斧劈砍面前扇形范围的敌人，造成100%物理伤害", 1.0f, 4.2f),
                new SkillDef("q",     "飞斧",   "proj",      3000,  0, "掷出旋转飞斧，命中第一个敌人造成150%物理伤害", 1.5f),
                new SkillDef("e",     "旋风斩", "aoe",       7000,  3, "旋身横扫，对周围5.5米敌人造成220%物理伤害，并减速30%（1.4秒）", 2.2f, 5.5f),
                new SkillDef("r",     "突进斩", "dashmelee", 12000, 5, "向前突进并挥出致命一斩，造成300%物理伤害，并击晕0.6秒", 3.0f, 5.0f),
            } },
            new ClassDef { id = "assassin", name = "刺客", role = "近战刺杀", icon = "🗡", speed = 8.8f, skills = new[] {
                new SkillDef("basic", "连刃", "melee",     480,   0, "双刃快速连击，攻速极快，每击95%物理伤害", 0.95f, 3.8f),
                new SkillDef("q",     "掷刃", "proj",      2600,  0, "掷出淬毒短刃，命中造成140%物理伤害", 1.4f),
                new SkillDef("e",     "影爆", "aoe",       6500,  3, "影气爆裂，对周围4.8米敌人造成200%物理伤害", 2.0f, 4.8f),
                new SkillDef("r",     "瞬杀", "dashmelee", 10000, 5, "瞬步突进割喉，造成340%物理伤害——刺客的处决技", 3.4f, 5.5f),
            } },
            new ClassDef { id = "ranger", name = "射手", role = "远程输出", icon = "🏹", speed = 8.3f, skills = new[] {
                new SkillDef("basic", "速射",     "proj",      700,   0, "快速射击，远距离命中造成85%物理伤害", 0.85f),
                new SkillDef("q",     "穿云箭",   "proj",      3000,  0, "蓄力强射，弹速极快射程极远，造成170%物理伤害", 1.7f),
                new SkillDef("e",     "箭雨",     "aoe",       8000,  3, "万箭齐发，对周围6.5米敌人造成180%物理伤害，并减速35%（1.6秒）", 1.8f, 6.5f),
                new SkillDef("r",     "猎杀冲锋", "dashmelee", 11000, 5, "突进拉开身位并近距离爆射，造成240%物理伤害", 2.4f, 4.5f),
            } },
            new ClassDef { id = "tank", name = "坦克", role = "前排壁垒", icon = "🛡", speed = 7.2f, skills = new[] {
                new SkillDef("basic", "盾击",     "melee",     750,   0, "挥盾横扫，造成100%物理伤害", 1.0f, 4.0f),
                new SkillDef("q",     "震地",     "aoe",       4000,  0, "重踏地面，对周围4米敌人造成110%物理伤害，并减速35%（2秒）", 1.1f, 4.0f),
                new SkillDef("e",     "盾墙冲击", "aoe",       8000,  3, "盾墙震荡冲击周围5.5米敌人，造成160%物理伤害，并定身1.2秒", 1.6f, 5.5f),
                new SkillDef("r",     "铁壁冲锋", "dashmelee", 12000, 5, "巨盾开路向前冲撞，造成220%物理伤害，并击晕0.9秒", 2.2f, 5.0f),
            } },
            new ClassDef { id = "healer", name = "奶妈", role = "治疗辅助", icon = "✨", speed = 8f, skills = new[] {
                new SkillDef("basic", "圣光弹",   "proj",    650,   0, "发射圣光法球，命中造成80%法术伤害", 0.8f),
                new SkillDef("q",     "治愈术",   "heal",    4500,  0, "治疗自己与9米内伤势最重的队友，恢复28%最大生命", 0f, 9f, 0.28f),
                new SkillDef("e",     "群体圣疗", "aoeheal", 10000, 3, "圣光普照，恢复周围8米所有队友22%最大生命", 0f, 8f, 0.22f),
                new SkillDef("r",     "圣光审判", "aoe",     12000, 5, "降下圣光审判，对周围5.5米敌人造成220%法术伤害，并击晕0.7秒", 2.2f, 5.5f),
            } },
        };

        public static ClassDef Cls(string id)
        {
            foreach (var c in Classes) if (c.id == id) return c;
            return Classes[0];
        }

        /* 职业在各次元的风格化称号 */
        static readonly Dictionary<string, string[]> ClassTitles = new Dictionary<string, string[]>
        {
            // 顺序与 Classes 一致：warrior/assassin/ranger/tank/healer
            { "tech",    new[] { "光刃武士", "量子刺客", "磁轨炮手", "重装机甲", "纳米医师" } },
            { "xiuxian", new[] { "剑修",     "影杀客",   "御符仙师", "体修金刚", "丹道医仙" } },
            { "cyber",   new[] { "街头武士", "暗巷刺客", "义体枪手", "重装保镖", "急救骇客" } },
            { "magic",   new[] { "圣殿骑士", "暗影刺客", "精灵射手", "守护骑士", "光明牧师" } },
            { "hunter",  new[] { "兽刃猎手", "影爪猎手", "鹰眼猎手", "巨盾猎手", "灵兽驯师" } },
        };

        public static string ClassTitle(string dimId, string clsId)
        {
            string[] titles;
            if (!ClassTitles.TryGetValue(dimId, out titles)) return Cls(clsId).name;
            for (int i = 0; i < Classes.Length; i++)
                if (Classes[i].id == clsId) return titles[i];
            return Cls(clsId).name;
        }

        /* 各次元×职业 的技能称号（顺序 basic/q/e/r）：保持技能机制不变，只把名字按次元元素重铸，
         * 让每个英雄的技能既贴合职业、又有次元特色。缺省回退到职业通用名。 */
        static readonly Dictionary<string, Dictionary<string, string[]>> SkillNamesByDim = new Dictionary<string, Dictionary<string, string[]>>
        {
            { "tech", new Dictionary<string, string[]> {
                { "warrior",  new[]{ "光刃斩",   "磁轨飞斧",   "涡轮旋斩",   "推进突袭" } },
                { "assassin", new[]{ "量子连刃", "飞射光刃",   "量子爆裂",   "量子瞬袭" } },
                { "ranger",   new[]{ "磁轨速射", "轨道穿甲弹", "导弹覆盖",   "突进爆射" } },
                { "tank",     new[]{ "机甲盾击", "震地重踏",   "力场冲击",   "机甲冲撞" } },
                { "healer",   new[]{ "纳米弹",   "纳米修复",   "群体纳米治疗", "轨道净化" } },
            } },
            { "xiuxian", new Dictionary<string, string[]> {
                { "warrior",  new[]{ "御剑斩",   "飞剑诀",     "万剑归宗",   "剑遁突刺" } },
                { "assassin", new[]{ "影杀连斩", "暗器飞刃",   "鬼影爆",     "瞬影杀" } },
                { "ranger",   new[]{ "御符飞射", "破云符箭",   "万符天雨",   "御剑追猎" } },
                { "tank",     new[]{ "金刚盾击", "撼地诀",     "金刚护体",   "蛮牛冲撞" } },
                { "healer",   new[]{ "灵气弹",   "回春诀",     "普度灵泉",   "仙雷天罚" } },
            } },
            { "cyber", new Dictionary<string, string[]> {
                { "warrior",  new[]{ "振动刃斩",   "飞旋锯刃",   "涡轮乱舞",   "义体冲撞" } },
                { "assassin", new[]{ "单分子连斩", "飞掷利刃",   "黑客脉冲",   "暗影突杀" } },
                { "ranger",   new[]{ "义体速射",   "智能穿甲弹", "弹幕覆盖",   "突进扫射" } },
                { "tank",     new[]{ "防暴盾击",   "震荡踏击",   "力盾冲击",   "装甲冲锋" } },
                { "healer",   new[]{ "治疗无人机", "急救注射",   "群体急救",   "系统过载" } },
            } },
            { "magic", new Dictionary<string, string[]> {
                { "warrior",  new[]{ "圣剑斩",   "投掷战斧",   "旋风圣斩",   "神圣突击" } },
                { "assassin", new[]{ "暗影连击", "暗影飞刃",   "暗影爆裂",   "影袭处决" } },
                { "ranger",   new[]{ "精灵速射", "穿云魔箭",   "万箭奇袭",   "游猎冲锋" } },
                { "tank",     new[]{ "圣盾打击", "神圣震地",   "圣盾壁垒",   "圣盾冲锋" } },
                { "healer",   new[]{ "圣光弹",   "治愈术",     "群体圣疗",   "圣光审判" } },
            } },
            { "hunter", new Dictionary<string, string[]> {
                { "warrior",  new[]{ "兽王斩",   "飞爪",       "旋风爪击",   "猛兽突袭" } },
                { "assassin", new[]{ "影爪连击", "飞针",       "念爆",       "影爪奇袭" } },
                { "ranger",   new[]{ "鹰眼速射", "贯穿狙击",   "箭雨风暴",   "猎杀冲锋" } },
                { "tank",     new[]{ "巨盾猛击", "践踏",       "兽盾冲击",   "巨盾冲锋" } },
                { "healer",   new[]{ "念力弹",   "念力疗愈",   "群体念疗",   "念力制裁" } },
            } },
        };
        static readonly string[] SkillKeyOrder = { "basic", "q", "e", "r" };
        // 取「次元+职业+技能键」的称号；查不到则回退职业通用技能名
        public static string SkillName(string dimId, string clsId, string key)
        {
            if (SkillNamesByDim.TryGetValue(dimId, out var byCls) && byCls.TryGetValue(clsId, out var names))
                for (int i = 0; i < SkillKeyOrder.Length; i++)
                    if (SkillKeyOrder[i] == key && i < names.Length) return names[i];
            return Cls(clsId).Skill(key).name;
        }

        /* 各次元×职业 的技能描述（顺序 basic/q/e/r）：数值/范围/控制与服务器一致，仅措辞按次元元素重写。 */
        static readonly Dictionary<string, Dictionary<string, string[]>> SkillDescByDim = new Dictionary<string, Dictionary<string, string[]>>
        {
            { "tech", new Dictionary<string, string[]> {
                { "warrior",  new[]{ "挥动光刃劈砍面前扇形范围，造成100%物理伤害", "射出磁轨飞斧，命中首个敌人造成150%物理伤害", "涡轮高速旋斩，对周围5.5米敌人造成220%物理伤害并减速30%（1.4秒）", "推进器突进斩杀，造成300%物理伤害并击晕0.6秒" } },
                { "assassin", new[]{ "量子双刃连击，攻速极快，每击95%物理伤害", "掷出高能光刃，命中造成140%物理伤害", "量子能量爆裂，对周围4.8米敌人造成200%物理伤害", "量子瞬移突袭割喉，造成340%物理伤害——处决技" } },
                { "ranger",   new[]{ "磁轨快速射击，远距离命中造成85%物理伤害", "蓄能轨道穿甲弹，弹速极快射程极远，造成170%物理伤害", "呼叫导弹覆盖，对周围6.5米敌人造成180%物理伤害并减速35%（1.6秒）", "突进拉开身位近距爆射，造成240%物理伤害" } },
                { "tank",     new[]{ "机甲护盾横扫，造成100%物理伤害", "重踏地面，对周围4米敌人造成110%物理伤害并减速35%（2秒）", "释放力场冲击周围5.5米敌人，造成160%物理伤害并定身1.2秒", "机甲全力冲撞，造成220%物理伤害并击晕0.9秒" } },
                { "healer",   new[]{ "发射纳米法球，命中造成80%法术伤害", "纳米机器人修复，治疗自己与9米内伤势最重的队友28%最大生命", "群体纳米喷洒，恢复周围8米队友22%最大生命", "呼叫轨道净化打击，对周围5.5米敌人造成220%法术伤害并击晕0.7秒" } },
            } },
            { "xiuxian", new Dictionary<string, string[]> {
                { "warrior",  new[]{ "御剑劈斩面前扇形范围，造成100%物理伤害", "祭出飞剑，命中首个敌人造成150%物理伤害", "万剑归宗环身斩杀，对周围5.5米敌人造成220%物理伤害并减速30%（1.4秒）", "剑遁瞬至一剑突刺，造成300%物理伤害并击晕0.6秒" } },
                { "assassin", new[]{ "影杀双刃连击，攻速极快，每击95%物理伤害", "打出淬毒暗器飞刃，命中造成140%物理伤害", "鬼影炸裂，对周围4.8米敌人造成200%物理伤害", "瞬影突袭割喉，造成340%物理伤害——刺客处决技" } },
                { "ranger",   new[]{ "御符飞射，远距离命中造成85%物理伤害", "破云符箭，符力极速远射，造成170%物理伤害", "万符天雨倾泻，对周围6.5米敌人造成180%物理伤害并减速35%（1.6秒）", "御剑追猎突进近射，造成240%物理伤害" } },
                { "tank",     new[]{ "金刚护盾横扫，造成100%物理伤害", "撼地诀震荡大地，对周围4米敌人造成110%物理伤害并减速35%（2秒）", "金刚护体震退周围5.5米敌人，造成160%物理伤害并定身1.2秒", "蛮牛之力冲撞，造成220%物理伤害并击晕0.9秒" } },
                { "healer",   new[]{ "凝聚灵气弹，命中造成80%法术伤害", "回春诀疗伤，治疗自己与9米内伤势最重的队友28%最大生命", "普度灵泉普照，恢复周围8米队友22%最大生命", "引动仙雷天罚，对周围5.5米敌人造成220%法术伤害并击晕0.7秒" } },
            } },
            { "cyber", new Dictionary<string, string[]> {
                { "warrior",  new[]{ "振动刀刃劈砍扇形范围，造成100%物理伤害", "掷出飞旋锯刃，命中首个敌人造成150%物理伤害", "涡轮锯刃乱舞，对周围5.5米敌人造成220%物理伤害并减速30%（1.4秒）", "义体增压冲撞斩杀，造成300%物理伤害并击晕0.6秒" } },
                { "assassin", new[]{ "单分子利刃连击，攻速极快，每击95%物理伤害", "飞掷单分子利刃，命中造成140%物理伤害", "黑客脉冲爆发，对周围4.8米敌人造成200%物理伤害", "暗影瞬袭处决，造成340%物理伤害" } },
                { "ranger",   new[]{ "义体快速射击，远距离命中造成85%物理伤害", "智能穿甲弹锁定要害，弹速极快，造成170%物理伤害", "弹幕覆盖压制，对周围6.5米敌人造成180%物理伤害并减速35%（1.6秒）", "突进近距扫射，造成240%物理伤害" } },
                { "tank",     new[]{ "防暴盾横扫，造成100%物理伤害", "震荡踏击地面，对周围4米敌人造成110%物理伤害并减速35%（2秒）", "力盾震荡冲击周围5.5米敌人，造成160%物理伤害并定身1.2秒", "重装甲冲锋撞击，造成220%物理伤害并击晕0.9秒" } },
                { "healer",   new[]{ "治疗无人机射出能量弹，命中造成80%法术伤害", "急救注射强心剂，治疗自己与9米内伤势最重的队友28%最大生命", "群体急救信号，恢复周围8米队友22%最大生命", "强制系统过载，对周围5.5米敌人造成220%法术伤害并击晕0.7秒" } },
            } },
            { "magic", new Dictionary<string, string[]> {
                { "warrior",  new[]{ "挥动圣剑劈砍扇形范围，造成100%物理伤害", "投掷战斧，命中首个敌人造成150%物理伤害", "旋风圣斩环身横扫，对周围5.5米敌人造成220%物理伤害并减速30%（1.4秒）", "神圣突击一斩，造成300%物理伤害并击晕0.6秒" } },
                { "assassin", new[]{ "暗影双刃连击，攻速极快，每击95%物理伤害", "掷出暗影飞刃，命中造成140%物理伤害", "暗影爆裂，对周围4.8米敌人造成200%物理伤害", "暗影突袭处决，造成340%物理伤害" } },
                { "ranger",   new[]{ "精灵之弓速射，远距离命中造成85%物理伤害", "穿云魔箭，箭速极快射程极远，造成170%物理伤害", "万箭奇袭齐发，对周围6.5米敌人造成180%物理伤害并减速35%（1.6秒）", "游猎突进近射，造成240%物理伤害" } },
                { "tank",     new[]{ "圣盾横扫，造成100%物理伤害", "神圣震地，对周围4米敌人造成110%物理伤害并减速35%（2秒）", "圣盾壁垒震荡周围5.5米敌人，造成160%物理伤害并定身1.2秒", "圣盾冲锋撞击，造成220%物理伤害并击晕0.9秒" } },
                { "healer",   new[]{ "发射圣光法球，命中造成80%法术伤害", "治疗自己与9米内伤势最重的队友，恢复28%最大生命", "圣光普照，恢复周围8米所有队友22%最大生命", "降下圣光审判，对周围5.5米敌人造成220%法术伤害并击晕0.7秒" } },
            } },
            { "hunter", new Dictionary<string, string[]> {
                { "warrior",  new[]{ "兽王利爪劈砍扇形范围，造成100%物理伤害", "掷出飞爪，命中首个敌人造成150%物理伤害", "旋风爪击环身横扫，对周围5.5米敌人造成220%物理伤害并减速30%（1.4秒）", "化身猛兽突袭，造成300%物理伤害并击晕0.6秒" } },
                { "assassin", new[]{ "影爪连击，攻速极快，每击95%物理伤害", "射出念力飞针，命中造成140%物理伤害", "念力爆发，对周围4.8米敌人造成200%物理伤害", "影爪奇袭处决，造成340%物理伤害" } },
                { "ranger",   new[]{ "鹰眼速射，远距离命中造成85%物理伤害", "贯穿狙击，弹速极快射程极远，造成170%物理伤害", "箭雨风暴倾泻，对周围6.5米敌人造成180%物理伤害并减速35%（1.6秒）", "猎杀突进近距爆射，造成240%物理伤害" } },
                { "tank",     new[]{ "巨盾猛击横扫，造成100%物理伤害", "野兽践踏，对周围4米敌人造成110%物理伤害并减速35%（2秒）", "兽盾震荡冲击周围5.5米敌人，造成160%物理伤害并定身1.2秒", "巨盾冲锋撞击，造成220%物理伤害并击晕0.9秒" } },
                { "healer",   new[]{ "射出念力弹，命中造成80%法术伤害", "念力疗愈，治疗自己与9米内伤势最重的队友28%最大生命", "群体念疗光环，恢复周围8米队友22%最大生命", "念力制裁，对周围5.5米敌人造成220%法术伤害并击晕0.7秒" } },
            } },
        };
        // 取「次元+职业+技能键」的描述；查不到则回退职业通用描述
        public static string SkillDesc(string dimId, string clsId, string key)
        {
            if (SkillDescByDim.TryGetValue(dimId, out var byCls) && byCls.TryGetValue(clsId, out var descs))
                for (int i = 0; i < SkillKeyOrder.Length; i++)
                    if (SkillKeyOrder[i] == key && i < descs.Length) return descs[i];
            return Cls(clsId).Skill(key).desc;
        }

        public static readonly string[] RarityNames = { "普通", "精良", "稀有", "史诗", "传说" };
        public static readonly Color[] RarityColors =
        { Hex("#95a5a6"), Hex("#2ecc71"), Hex("#3498db"), Hex("#9b59b6"), Hex("#f39c12") };

        public static readonly Dictionary<string, string> SlotNames = new Dictionary<string, string>
        { { "weapon", "武器" }, { "helmet", "帽子" }, { "armor", "衣服" }, { "boots", "鞋子" }, { "acc", "饰品" } };
    }
}
