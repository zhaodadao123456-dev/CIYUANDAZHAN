/* ============================================================
 * 次元大战 - 购买素材一键接入向导（编辑器工具）
 * 菜单：次元大战 → ① 生成资源清单 / ② 一键接入已购模型
 * ============================================================ */
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using UnityEditor;
using UnityEditor.Animations;
using UnityEngine;

namespace DW.EditorTools
{
    public static class DWSetupWizard
    {
        const string ResDir = "Assets/Resources/DW";

        [MenuItem("次元大战/① 生成资源清单(发给Claude)")]
        public static void MakeReport()
        {
            var sb = new StringBuilder();
            sb.AppendLine("===== 次元大战 资源清单（全项目角色）=====");
            foreach (var path in AllCharacterPrefabs())
            {
                var go = AssetDatabase.LoadAssetAtPath<GameObject>(path);
                var anim = go != null ? go.GetComponentInChildren<Animator>(true) : null;
                var human = anim != null && anim.avatar != null && anim.avatar.isHuman;
                sb.AppendLine($"[角色] {path}  人形骨骼:{(human ? "是" : "否")}");
            }
            sb.AppendLine("\n--- 动画片段 ---");
            foreach (var guid in AssetDatabase.FindAssets("t:AnimationClip"))
            {
                var path = AssetDatabase.GUIDToAssetPath(guid);
                if (!path.StartsWith("Assets/")) continue;
                foreach (var clip in AssetDatabase.LoadAllAssetsAtPath(path).OfType<AnimationClip>())
                {
                    if (clip.name.StartsWith("__preview")) continue;
                    sb.AppendLine($"[动画] {clip.name}  时长:{clip.length:0.00}s  人形:{(clip.isHumanMotion ? "是" : "否")}  来自:{path}");
                }
            }
            var outPath = "Assets/DW_资源清单.txt";
            File.WriteAllText(outPath, sb.ToString());
            AssetDatabase.Refresh();
            Debug.Log(sb.ToString());
            EditorUtility.DisplayDialog("次元大战",
                $"清单已生成：{outPath}\n\n把这个文件内容发给 Claude，即可精确分配每个角色。", "好");
        }

        /* 各职业候选关键词（按优先级；匹配资源路径，命中即选，且不重复使用） */
        static readonly (string key, string cls, string[] keys)[] HeroRules =
        {
            ("xiuxian", "刺客", new[] { "wukong", "悟空", "monkey", "ninja", "assassin", "rogue", "samurai" }),
            ("magic",   "奶妈", new[] { "witch", "女巫", "nun", "修女", "priest", "cleric", "missionary", "传教士", "mage", "heal" }),
            ("cyber",   "射手", new[] { "cowboy", "sheriff", "牛仔", "archer", "ranger", "gun", "trooper_girl", "girl_v" }),
            ("tech",    "坦克", new[] { "trooper", "sci-fi", "scifi", "knight", "armor", "guard", "robot", "mech", "heavy", "lord" }),
            ("hunter",  "战士", new[] { "half_blood", "halfblood", "半血", "warrior", "sword", "fighter", "barbarian", "man", "cowboy" }),
        };

        /* 怪物候选关键词（骷髅/亡灵/恶魔类做怪物） */
        static readonly string[] MonsterKeys = { "skeleton", "骷髅", "skull", "undead", "zombie", "demon", "恶魔", "monster", "怪", "ghoul", "clown", "小丑", "jester" };

        [MenuItem("次元大战/② 一键接入已购模型(自动)")]
        public static void AutoWire()
        {
            Directory.CreateDirectory(ResDir);
            var log = new StringBuilder("===== 自动接入结果 =====\n");

            // 全项目扫描所有「角色」预制体（带蒙皮网格）
            var allChars = AllCharacterPrefabs();
            log.AppendLine($"扫描到角色预制体 {allChars.Count} 个\n");

            // 1. 通用动画控制器：优先用悟空包的人形动作片段
            string wukong = FindFolder("wukong", "悟空");
            AnimatorController ctrl = BuildController(wukong, log);

            // 2. 英雄分配：按关键词从全项目角色池里挑，已用过的不再选
            var used = new HashSet<string>();
            foreach (var (key, cls, keys) in HeroRules)
            {
                var src = PickByKeywords(allChars, keys, used)
                          ?? allChars.FirstOrDefault((p) => !used.Contains(p));   // 兜底：随便给个没用过的
                if (src == null) { log.AppendLine($"hero_{key}（{cls}）：无可用角色，保留占位"); continue; }
                used.Add(src);
                SaveCharPrefab(src, $"{ResDir}/hero_{key}.prefab", ctrl, $"hero_{key}（{cls}）", log);
            }

            // 3. 怪物分配：把骷髅/亡灵类角色做成 mon_t1~t4
            var monsters = allChars.Where((p) => MonsterKeys.Any((k) => Lower(p).Contains(k))).ToList();
            if (monsters.Count > 0)
            {
                for (int i = 0; i < 4; i++)
                {
                    var src = monsters[i % monsters.Count];   // 不足4个就循环复用
                    SaveCharPrefab(src, $"{ResDir}/mon_t{i + 1}.prefab", ctrl, $"mon_t{i + 1}", log);
                }
            }
            else log.AppendLine("未发现骷髅/怪物类角色，怪物沿用 KayKit 默认模型");

            AssetDatabase.SaveAssets();
            AssetDatabase.Refresh();
            Debug.Log(log.ToString());
            File.WriteAllText("Assets/DW_接入结果.txt", log.ToString());
            EditorUtility.DisplayDialog("次元大战", log + "\n\n点 ▶ 运行即可看到新模型。\n效果不满意把 Assets/DW_接入结果.txt 发给 Claude 精调。", "好");
        }

        /* 把一个角色源复制成标准命名 Prefab 并挂动画控制器 */
        static void SaveCharPrefab(string src, string dst, AnimatorController ctrl, string label, StringBuilder log)
        {
            AssetDatabase.DeleteAsset(dst);
            var srcGo = AssetDatabase.LoadAssetAtPath<GameObject>(src);
            if (srcGo == null) { log.AppendLine($"{label}：加载失败 {src}"); return; }
            var inst = (GameObject)Object.Instantiate(srcGo);
            var animator = inst.GetComponentInChildren<Animator>();
            if (animator == null) animator = inst.AddComponent<Animator>();
            bool human = animator.avatar != null && animator.avatar.isHuman;
            if (ctrl != null && human) animator.runtimeAnimatorController = ctrl;
            PrefabUtility.SaveAsPrefabAsset(inst, dst);
            Object.DestroyImmediate(inst);
            log.AppendLine($"{label} ← {src}  动画:{(ctrl != null && human ? "已挂" : "静态(非人形骨骼)")}");
        }

        /* 从角色池里按关键词优先级挑一个未使用的 */
        static string PickByKeywords(List<string> pool, string[] keys, HashSet<string> used)
        {
            foreach (var k in keys)
            {
                var hit = pool.FirstOrDefault((p) => !used.Contains(p) && Lower(p).Contains(k));
                if (hit != null) return hit;
            }
            return null;
        }

        /* 全项目角色预制体（带蒙皮网格、人形优先、完整版优先、排除自己生成的 Resources/DW） */
        static List<string> AllCharacterPrefabs()
        {
            return AssetDatabase.FindAssets("t:Prefab")
                .Select(AssetDatabase.GUIDToAssetPath)
                .Where((p) => p.StartsWith("Assets/") && !p.StartsWith("Assets/Resources/"))
                .Where((p) => {
                    var go = AssetDatabase.LoadAssetAtPath<GameObject>(p);
                    return go != null && go.GetComponentInChildren<SkinnedMeshRenderer>(true) != null;
                })
                .OrderByDescending((p) => {
                    var go = AssetDatabase.LoadAssetAtPath<GameObject>(p);
                    var an = go.GetComponentInChildren<Animator>(true);
                    return (an != null && an.avatar != null && an.avatar.isHuman) ? 1 : 0;   // 人形优先
                })
                .ThenByDescending((p) => Lower(p).Contains("full") ? 1 : 0)
                .ToList();
        }

        /* 用某个包的人形动作片段搭通用控制器 */
        static AnimatorController BuildController(string clipFolder, StringBuilder log)
        {
            if (clipFolder == null) { log.AppendLine("⚠ 未找到悟空动画包，角色将静态展示"); return null; }
            var states = PickStates(AllClips(clipFolder));
            if (states.Count == 0) { log.AppendLine("⚠ 未识别出可用动作片段"); return null; }
            var ctrlPath = ResDir + "/dw_hero_anim.controller";
            AssetDatabase.DeleteAsset(ctrlPath);
            var ctrl = AnimatorController.CreateAnimatorControllerAtPath(ctrlPath);
            var sm = ctrl.layers[0].stateMachine;
            foreach (var kv in states)
            {
                var st = sm.AddState(kv.Key);
                st.motion = kv.Value;
                if (kv.Key == "Idle") sm.defaultState = st;
                log.AppendLine($"动画 {kv.Key} ← {kv.Value.name}");
            }
            return ctrl;
        }

        /* ---------- 工具函数 ---------- */
        static string Lower(string s) => s.ToLowerInvariant();

        static string FindFolder(params string[] keys)
        {
            foreach (var d in Directory.GetDirectories("Assets"))
            {
                var n = Lower(Path.GetFileName(d)).Replace("-", "_").Replace(" ", "_");
                foreach (var k in keys)
                    if (n.Contains(k.Replace("-", "_").Replace(" ", "_"))) return d.Replace('\\', '/');
            }
            return null;
        }

        static List<AnimationClip> AllClips(string folder)
        {
            var list = new List<AnimationClip>();
            foreach (var guid in AssetDatabase.FindAssets("t:AnimationClip", new[] { folder }))
                foreach (var c in AssetDatabase.LoadAllAssetsAtPath(AssetDatabase.GUIDToAssetPath(guid)).OfType<AnimationClip>())
                    if (!c.name.StartsWith("__preview")) list.Add(c);
            return list;
        }

        /* 按动作名关键词挑选状态片段（关键词按优先级排序，越靠前越优先匹配） */
        static Dictionary<string, AnimationClip> PickStates(List<AnimationClip> clips)
        {
            var rules = new (string state, string[] keys)[]
            {
                ("Idle",   new[] { "idle", "stand" }),
                ("Run",    new[] { "jog", "run", "sprint", "walk" }),
                ("Attack1",new[] { "attackl", "attack_l", "attack", "punch", "slash", "sword", "staff", "hit_" }),
                ("Skill",  new[] { "attackr", "attack_r", "cast", "skill", "spin", "spell", "heavy", "chest" }),
                ("Dodge",  new[] { "roll", "dodge", "dash" }),
                ("Death",  new[] { "death", "die", "dead" }),
            };
            var res = new Dictionary<string, AnimationClip>();
            foreach (var (state, keys) in rules)
            {
                foreach (var k in keys)
                {
                    var hit = clips.FirstOrDefault((c) => Lower(c.name).Contains(k));
                    if (hit != null) { res[state] = hit; break; }
                }
            }
            // 技能动画兜底：实在没有就复用普攻
            if (!res.ContainsKey("Skill") && res.ContainsKey("Attack1")) res["Skill"] = res["Attack1"];
            return res;
        }
    }
}
