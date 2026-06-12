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
        public SkillDef(string key, string name, string kind, float cdMs, int minLvl, string desc)
        { this.key = key; this.name = name; this.kind = kind; this.cdMs = cdMs; this.minLvl = minLvl; this.desc = desc; }
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
        public const float MapHalf = 70f;

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
                new SkillDef("basic", "劈砍",   "melee",     600,   0, "挥斧劈砍面前扇形范围的敌人，造成100%物理伤害"),
                new SkillDef("q",     "飞斧",   "proj",      3000,  0, "掷出旋转飞斧，命中第一个敌人造成150%物理伤害"),
                new SkillDef("e",     "旋风斩", "aoe",       7000,  3, "旋身横扫，对周围5.5米敌人造成220%物理伤害"),
                new SkillDef("r",     "突进斩", "dashmelee", 12000, 5, "向前突进并挥出致命一斩，造成300%物理伤害"),
            } },
            new ClassDef { id = "assassin", name = "刺客", role = "近战刺杀", icon = "🗡", speed = 8.8f, skills = new[] {
                new SkillDef("basic", "连刃", "melee",     480,   0, "双刃快速连击，攻速极快，每击95%物理伤害"),
                new SkillDef("q",     "掷刃", "proj",      2600,  0, "掷出淬毒短刃，命中造成140%物理伤害"),
                new SkillDef("e",     "影爆", "aoe",       6500,  3, "影气爆裂，对周围4.8米敌人造成200%物理伤害"),
                new SkillDef("r",     "瞬杀", "dashmelee", 10000, 5, "瞬步突进割喉，造成340%物理伤害"),
            } },
            new ClassDef { id = "ranger", name = "射手", role = "远程输出", icon = "🏹", speed = 8.3f, skills = new[] {
                new SkillDef("basic", "速射",     "proj",      700,   0, "快速射击，远距离命中造成85%物理伤害"),
                new SkillDef("q",     "穿云箭",   "proj",      3000,  0, "蓄力强射，弹速极快射程极远，造成170%物理伤害"),
                new SkillDef("e",     "箭雨",     "aoe",       8000,  3, "万箭齐发，对周围6.5米敌人造成180%物理伤害"),
                new SkillDef("r",     "猎杀冲锋", "dashmelee", 11000, 5, "突进拉开身位并近距离爆射，造成240%物理伤害"),
            } },
            new ClassDef { id = "tank", name = "坦克", role = "前排壁垒", icon = "🛡", speed = 7.2f, skills = new[] {
                new SkillDef("basic", "盾击",     "melee",     750,   0, "挥盾横扫，造成100%物理伤害"),
                new SkillDef("q",     "震地",     "aoe",       4000,  0, "重踏地面，对周围4米敌人造成110%物理伤害"),
                new SkillDef("e",     "盾墙冲击", "aoe",       8000,  3, "盾墙震荡冲击周围5.5米敌人，造成160%物理伤害"),
                new SkillDef("r",     "铁壁冲锋", "dashmelee", 12000, 5, "巨盾开路向前冲撞，造成220%物理伤害"),
            } },
            new ClassDef { id = "healer", name = "奶妈", role = "治疗辅助", icon = "✨", speed = 8f, skills = new[] {
                new SkillDef("basic", "圣光弹",   "proj",    650,   0, "发射圣光法球，命中造成80%法术伤害"),
                new SkillDef("q",     "治愈术",   "heal",    4500,  0, "治疗自己与9米内伤势最重的队友，恢复28%最大生命"),
                new SkillDef("e",     "群体圣疗", "aoeheal", 10000, 3, "圣光普照，恢复周围8米所有队友22%最大生命"),
                new SkillDef("r",     "圣光审判", "aoe",     12000, 5, "降下圣光审判，对周围5.5米敌人造成220%法术伤害"),
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

        public static readonly string[] RarityNames = { "普通", "精良", "稀有", "史诗", "传说" };
        public static readonly Color[] RarityColors =
        { Hex("#95a5a6"), Hex("#2ecc71"), Hex("#3498db"), Hex("#9b59b6"), Hex("#f39c12") };

        public static readonly Dictionary<string, string> SlotNames = new Dictionary<string, string>
        { { "weapon", "武器" }, { "helmet", "帽子" }, { "armor", "衣服" }, { "boots", "鞋子" }, { "acc", "饰品" } };
    }
}
