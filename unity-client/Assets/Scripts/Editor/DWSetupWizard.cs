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

        /* 各职业的模型键位（与网页版 CLASSES.model 一致） */
        static readonly (string key, string cls)[] HeroKeys =
        {
            ("tech", "坦克"), ("xiuxian", "刺客"), ("cyber", "射手"),
            ("magic", "奶妈"), ("hunter", "战士"),
        };

        [MenuItem("次元大战/① 生成资源清单(发给Claude)")]
        public static void MakeReport()
        {
            var sb = new StringBuilder();
            sb.AppendLine("===== 次元大战 资源清单 =====");
            foreach (var folder in PackFolders())
            {
                sb.AppendLine($"\n## 包目录: {folder}");
                foreach (var guid in AssetDatabase.FindAssets("t:Prefab", new[] { folder }))
                {
                    var path = AssetDatabase.GUIDToAssetPath(guid);
                    var go = AssetDatabase.LoadAssetAtPath<GameObject>(path);
                    var skin = go != null && go.GetComponentInChildren<SkinnedMeshRenderer>(true) != null;
                    var anim = go != null ? go.GetComponentInChildren<Animator>(true) : null;
                    var human = anim != null && anim.avatar != null && anim.avatar.isHuman;
                    sb.AppendLine($"[Prefab] {path}  蒙皮:{(skin ? "有" : "无")}  人形骨骼:{(human ? "是" : "否")}");
                }
                foreach (var guid in AssetDatabase.FindAssets("t:Model", new[] { folder }))
                {
                    var path = AssetDatabase.GUIDToAssetPath(guid);
                    sb.AppendLine($"[模型] {path}");
                }
                foreach (var guid in AssetDatabase.FindAssets("t:AnimationClip", new[] { folder }))
                {
                    var path = AssetDatabase.GUIDToAssetPath(guid);
                    foreach (var clip in AssetDatabase.LoadAllAssetsAtPath(path).OfType<AnimationClip>())
                    {
                        if (clip.name.StartsWith("__preview")) continue;
                        sb.AppendLine($"[动画] {clip.name}  时长:{clip.length:0.00}s  人形:{(clip.isHumanMotion ? "是" : "否")}  来自:{path}");
                    }
                }
            }
            var outPath = "Assets/DW_资源清单.txt";
            File.WriteAllText(outPath, sb.ToString());
            AssetDatabase.Refresh();
            Debug.Log(sb.ToString());
            EditorUtility.DisplayDialog("次元大战",
                $"清单已生成：{outPath}\n\n把这个文件内容发给 Claude，即可精确接入。\n（也可以先试菜单②自动接入）", "好");
        }

        [MenuItem("次元大战/② 一键接入已购模型(自动)")]
        public static void AutoWire()
        {
            Directory.CreateDirectory(ResDir);
            var log = new StringBuilder("===== 自动接入结果 =====\n");

            string wukong = FindFolder("wukong", "悟空");
            string halfBlood = FindFolder("half_blood", "halfblood", "half blood");
            string sciFi = FindFolder("sci-fi", "scifi", "troopers");

            // 1. 选角色 Prefab：悟空→修仙(刺客)；科幻士兵→科技(坦克)+赛博(射手)；半血男女→猎人(战士,男)+魔法(奶妈,女)
            var picks = new Dictionary<string, string>();   // heroKey -> assetPath
            if (wukong != null)
                Assign(picks, "xiuxian", CharacterAssets(wukong).FirstOrDefault());
            if (sciFi != null)
            {
                var troopers = CharacterAssets(sciFi).ToList();
                Assign(picks, "tech", troopers.ElementAtOrDefault(0));
                Assign(picks, "cyber", troopers.ElementAtOrDefault(1) ?? troopers.ElementAtOrDefault(0));
            }
            if (halfBlood != null)
            {
                var chars = CharacterAssets(halfBlood).ToList();
                var female = chars.FirstOrDefault((p) => Lower(p).Contains("female") || Lower(p).Contains("girl") || Lower(p).Contains("woman"));
                var male = chars.FirstOrDefault((p) => p != female);
                Assign(picks, "magic", female ?? chars.ElementAtOrDefault(1));
                Assign(picks, "hunter", male ?? chars.ElementAtOrDefault(0));
            }

            // 2. 用悟空包的动作片段搭一个通用动画控制器（Quaternius CC0 人形动画）
            AnimatorController ctrl = null;
            bool clipsHuman = false;
            if (wukong != null)
            {
                var clips = AllClips(wukong);
                var states = PickStates(clips);
                if (states.Count > 0)
                {
                    clipsHuman = states.Values.First().isHumanMotion;
                    var ctrlPath = ResDir + "/dw_hero_anim.controller";
                    AssetDatabase.DeleteAsset(ctrlPath);
                    ctrl = AnimatorController.CreateAnimatorControllerAtPath(ctrlPath);
                    var sm = ctrl.layers[0].stateMachine;
                    foreach (var kv in states)
                    {
                        var st = sm.AddState(kv.Key);
                        st.motion = kv.Value;
                        if (kv.Key == "Idle") sm.defaultState = st;
                        log.AppendLine($"动画状态 {kv.Key} ← {kv.Value.name}（人形:{kv.Value.isHumanMotion}）");
                    }
                }
                else log.AppendLine("⚠ 悟空包里没有识别出可用动作片段");
            }

            // 3. 复制成标准命名 Prefab 并挂控制器
            foreach (var (key, cls) in HeroKeys)
            {
                string src;
                if (!picks.TryGetValue(key, out src) || src == null)
                {
                    log.AppendLine($"hero_{key}（{cls}）：未找到候选模型，保留占位小人");
                    continue;
                }
                var dst = $"{ResDir}/hero_{key}.prefab";
                AssetDatabase.DeleteAsset(dst);
                var srcGo = AssetDatabase.LoadAssetAtPath<GameObject>(src);
                var inst = (GameObject)Object.Instantiate(srcGo);
                var animator = inst.GetComponentInChildren<Animator>();
                if (animator == null) animator = inst.AddComponent<Animator>();
                bool avatarHuman = animator.avatar != null && animator.avatar.isHuman;
                bool sameAsClipPack = wukong != null && src.StartsWith(wukong);
                if (ctrl != null && ((avatarHuman && clipsHuman) || sameAsClipPack))
                    animator.runtimeAnimatorController = ctrl;
                PrefabUtility.SaveAsPrefabAsset(inst, dst);
                Object.DestroyImmediate(inst);
                log.AppendLine($"hero_{key}（{cls}）← {src}  动画:{(ctrl != null && ((avatarHuman && clipsHuman) || sameAsClipPack) ? "已挂" : "暂无(人形骨骼不匹配)")}");
            }

            AssetDatabase.SaveAssets();
            AssetDatabase.Refresh();
            Debug.Log(log.ToString());
            File.WriteAllText("Assets/DW_接入结果.txt", log.ToString());
            EditorUtility.DisplayDialog("次元大战", log + "\n\n点 ▶ 运行即可看到新模型。\n效果不满意就把 Assets/DW_资源清单.txt 发给 Claude 精调。", "好");
        }

        /* ---------- 工具函数 ---------- */
        static string Lower(string s) => s.ToLowerInvariant();

        static IEnumerable<string> PackFolders()
        {
            foreach (var d in Directory.GetDirectories("Assets"))
            {
                var n = Lower(Path.GetFileName(d));
                if (n.Contains("wukong") || n.Contains("悟空") || n.Contains("half") || n.Contains("sci") || n.Contains("trooper"))
                    yield return d.Replace('\\', '/');
            }
        }

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

        /* 角色候选：带蒙皮网格的 Prefab 优先，其次 FBX 模型 */
        static IEnumerable<string> CharacterAssets(string folder)
        {
            var prefabs = AssetDatabase.FindAssets("t:Prefab", new[] { folder })
                .Select(AssetDatabase.GUIDToAssetPath)
                .Where((p) => {
                    var go = AssetDatabase.LoadAssetAtPath<GameObject>(p);
                    return go != null && go.GetComponentInChildren<SkinnedMeshRenderer>(true) != null;
                })
                // 优先「完整」版角色（带 full），避免选到只有局部部件的变体
                .OrderByDescending((p) => Lower(p).Contains("full") ? 1 : 0)
                .ThenBy((p) => Lower(p)).ToList();
            if (prefabs.Count > 0) return prefabs;
            return AssetDatabase.FindAssets("t:Model", new[] { folder })
                .Select(AssetDatabase.GUIDToAssetPath)
                .Where((p) => {
                    var go = AssetDatabase.LoadAssetAtPath<GameObject>(p);
                    return go != null && go.GetComponentInChildren<SkinnedMeshRenderer>(true) != null;
                })
                .OrderBy((p) => Lower(p));
        }

        static void Assign(Dictionary<string, string> picks, string key, string path)
        {
            if (path != null) picks[key] = path;
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
