/* ============================================================
 * 次元大战 - 购买素材一键接入向导（编辑器工具）
 * 菜单：次元大战 → ① 生成资源清单 / ② 一键接入已购模型
 * ============================================================ */
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;
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
            sb.AppendLine("\n--- 特效预制体（Hovl 等带粒子的，可接到技能/受击）---");
            int vfxN = 0;
            foreach (var guid in AssetDatabase.FindAssets("t:GameObject"))
            {
                if (vfxN >= 200) { sb.AppendLine("…(已达上限，其余省略)"); break; }
                var path = AssetDatabase.GUIDToAssetPath(guid);
                if (!path.StartsWith("Assets/") || path.StartsWith("Assets/Resources/")) continue;
                if (!Lower(path).EndsWith(".prefab")) continue;
                bool hovl = Lower(path).Contains("hovl");
                var go = AssetDatabase.LoadAssetAtPath<GameObject>(path);
                if (go == null) continue;
                if (!hovl && go.GetComponentInChildren<ParticleSystem>(true) == null) continue;
                sb.AppendLine($"[特效] {path}");
                vfxN++;
            }
            if (vfxN == 0) sb.AppendLine("（未发现特效预制体）");

            var outPath = "Assets/DW_资源清单.txt";
            File.WriteAllText(outPath, sb.ToString());
            AssetDatabase.Refresh();
            Debug.Log(sb.ToString());
            EditorUtility.DisplayDialog("次元大战",
                $"清单已生成：{outPath}\n\n把这个文件内容发给 Claude，即可精确分配每个角色。", "好");
        }

        /* 角色分类关键词 */
        static readonly string[] BossKeys = { "clown", "jester", "小丑", "弄臣", "littlewitch", "little_witch" };
        static readonly string[] MonsterKeys = { "skeleton", "骷髅", "skull", "undead", "zombie", "尸", "demon", "恶魔", "ghoul", "lich", "monster", "怪" };
        /* 英雄池排序优先级（让常见职业形象排在前面，组合取模时更顺眼） */
        static readonly string[] HeroPriority = { "wukong", "悟空", "witch", "女巫", "cowboy", "sheriff", "牛仔", "trooper", "half_blood", "半血", "nun", "修女", "missionary", "传教士", "bunny", "兔" };

        /* 次元专属英雄分配规则（依据真实资源清单的购买包，按 heroSrcs 顺序取首个匹配）：
         *   修仙 ← 悟空(WukongB，全套人形动作)
         *   西方魔法 ← Half_Blood / 教会侍从（人形，重定向悟空动作）
         *   科技 ← Sci-Fi 士兵 v.1     赛博朋克 ← Sci-Fi 士兵 v.2
         *   猎人 ← 牛仔女警长（持枪=猎人感）
         * 士兵包原为 Generic 骨骼无动作，SaveCharPrefab(forceHuman) 会自动转 Humanoid 并重导入。 */
        static readonly (string dim, System.Func<string, bool> match)[] DimHeroRules =
        {
            ("xiuxian", (p) => Has(p, "wukong", "悟空")),
            ("magic",   (p) => Has(p, "half_blood", "servant_church", "church", "半血") && !Has(p, "gun", "sword", "stand")),
            ("tech",    (p) => Has(p, "trooper") && Has(p, "v.1", "v1")),
            ("cyber",   (p) => Has(p, "trooper") && Has(p, "v.2", "v2")),
            ("hunter",  (p) => Has(p, "cowboy", "sheriff", "牛仔", "hunter", "archer", "ranger", "猎")),
        };
        static bool Has(string p, params string[] keys) { var l = Lower(p); foreach (var k in keys) if (l.Contains(k)) return true; return false; }
        /* 五次元顺序（与 DWData.Dims 一致），用于把多余角色补满每个次元 */
        static readonly string[] DimOrder = { "tech", "xiuxian", "cyber", "magic", "hunter" };

        const string HeroDir = "Assets/Resources/DWHeroes";
        const string MobDir = "Assets/Resources/DWMobs";
        const string SceneDir = "Assets/Resources/DWScene";

        /* 适合散布到野外的"道具型"静态模型关键词（柱子/石棺/木桶/骸骨…） */
        static readonly string[] ScenePropKeys = {
            // 自然（PurePoly / SimpleNature）
            "tree", "palm", "rock", "stone", "boulder", "pebble", "plant", "bush", "shrub", "grass", "flower", "fern", "mushroom", "log", "stump", "branch", "reed", "cactus", "lily", "weed", "hedge", "moss", "root",
            // 通用道具
            "pillar", "column", "statue", "barrel", "crate", "box", "chest", "pot", "vase", "lamp", "lantern", "torch", "brazier", "fountain", "cart", "shelf", "fence", "well", "altar", "crystal", "pile", "debris", "banner", "grave", "tomb", "ruin", "rubble", "bone", "skull", "sarcophag", "coffin", "candle", "cage", "pumpkin",
            // 工业（RPG_FPS）
            "container", "oil", "tank", "dumpster", "pallet", "pipe", "sack", "tire", "scaffold", "generator", "vent", "antenna" };
        /* 结构件 / 武器 / 地形大块 / 主题杂物 不散布（平铺会很丑或不合适） */
        static readonly string[] SceneBadKeys = { "floor", "wall", "ceiling", "door", "stair", "tile", "ground", "roof", "corner", "arch", "bridge", "platform", "ramp", "window", "frame", "plane", "terrain", "ceil", "_lod", "collision", "modular_",
            "gun", "sword", "bullet", "knife", "axe", "rifle", "pistol", "weapon", "ammo", "blade", "magazine",
            "water", "hill", "mountain", "plateau", "riverbed", "iceberg", "floe", "iglo", "cliff", "river", "lake", "island", "road",
            "candy", "present", "santa", "sleigh", "snowman", "surfboard", "sandcastle", "umbrella", "lifebelt", "volleyball", "soccer", "coconut", "bucket", "shovel", "rake", "boat", "dock", "bottle", "paper", "lighthouse", "windmill", "anchor", "chain", "rope", "fishing", "starfish", "seashell", "ball", "toy", "chair", "sign", "building", "house", "tent" };

        /* 特效/粒子预制体：即便带 SkinnedMesh 也不是角色（如自然包的 FX_Waterfall），不能进英雄/怪物池 */
        static readonly string[] EffectKeys = { "/fx/", "/vfx/", "/effects/", "/effect/", "particle", "waterfall" };
        static bool IsEffectPrefab(string path)
        {
            var n = Lower(path);
            foreach (var k in EffectKeys) if (n.Contains(k)) return true;
            var f = Lower(Path.GetFileName(path));
            return f.StartsWith("fx_") || f.StartsWith("vfx_");
        }

        /* 全项目"静态场景道具"：有 MeshRenderer 无 SkinnedMesh、名字像道具、非角色、非管线变体 */
        static List<string> SceneryProps()
        {
            var picks = AssetDatabase.FindAssets("t:GameObject")
                .Select(AssetDatabase.GUIDToAssetPath)
                .Where((p) => p.StartsWith("Assets/") && !p.StartsWith("Assets/Resources/") && Lower(p).EndsWith(".prefab"))
                .Where((p) => !BadPrefabVariant(p))
                .Where((p) => {
                    var n = Lower(Path.GetFileNameWithoutExtension(p));
                    return ScenePropKeys.Any((k) => n.Contains(k)) && !SceneBadKeys.Any((k) => n.Contains(k));
                })
                .Where((p) => {
                    var go = AssetDatabase.LoadAssetAtPath<GameObject>(p);
                    return go != null && go.GetComponentInChildren<SkinnedMeshRenderer>(true) == null
                                      && go.GetComponentInChildren<MeshRenderer>(true) != null;
                });
            // 每个角色基名只取一个，最多 30 个，避免刷屏
            var seen = new HashSet<string>();
            var res = new List<string>();
            foreach (var p in picks)
                if (seen.Add(NormBase(p)) && res.Count < 80) res.Add(p);
            return res;
        }

        [MenuItem("次元大战/② 一键接入已购模型(自动)")]
        public static void AutoWire()
        {
            Directory.CreateDirectory(ResDir);
            // 清掉上次的次元英雄（含次元×职业），确保每次都重新分配
            foreach (var d in DimOrder)
            {
                AssetDatabase.DeleteAsset($"{ResDir}/hero_{d}.prefab");
                foreach (var cls in new[] { "warrior", "assassin", "ranger", "tank", "healer" })
                    AssetDatabase.DeleteAsset($"{ResDir}/hero_{d}_{cls}.prefab");
            }
            var log = new StringBuilder("===== 自动接入结果 =====\n");

            var allChars = AllCharacterPrefabs();
            log.AppendLine($"扫描到角色预制体 {allChars.Count} 个\n");

            // 动画源：所有英雄统一用悟空整套人形动作（攻击/走路/奔跑等，按用户要求改回以前的）。
            // 狐狸文件夹仍转为 Humanoid，以便狐狸作为修仙刺客能套用悟空的人形动作。
            var huliFolder = FindFolder("huli", "fox", "狐狸");
            if (huliFolder != null) ForceFolderHumanoid(huliFolder, log);
            AnimatorController ctrl = BuildController(FindFolder("wukong", "悟空"), log);

            // 分类：小丑→BOSS；骷髅/亡灵→怪物；其余人物→英雄池
            bool IsBoss(string p) => BossKeys.Any((k) => Lower(p).Contains(k));
            bool IsMon(string p) => MonsterKeys.Any((k) => Lower(p).Contains(k));
            var bossSrcs = DedupePacks(allChars.Where(IsBoss).ToList());
            var monSrcs  = DedupePacks(allChars.Where((p) => IsMon(p) && !IsBoss(p)).ToList());
            var heroSrcs = DedupePacks(allChars.Where((p) => !IsBoss(p) && !IsMon(p)).ToList());
            // 英雄池按优先级排序（常见形象在前）
            heroSrcs = heroSrcs.OrderBy((p) => {
                for (int i = 0; i < HeroPriority.Length; i++) if (Lower(p).Contains(HeroPriority[i])) return i;
                return 999;
            }).ToList();

            // 世界BOSS（小丑）：小丑是 Generic 骨骼，用它自己包里的动作搭一个通用控制器
            if (bossSrcs.Count > 0)
            {
                var bsrc = bossSrcs[0];
                var bGo = AssetDatabase.LoadAssetAtPath<GameObject>(bsrc);
                AnimatorController bctrl = ctrl; bool bGeneric = false;
                if (!HasHumanAvatar(bGo))   // 小丑等 Generic：用自己包的动作
                {
                    bctrl = BuildGenericController(TopFolder(bsrc), "boss", log) ?? ctrl;
                    bGeneric = bctrl != ctrl;
                }
                SaveCharPrefab(bsrc, $"{ResDir}/mon_boss.prefab", bctrl, "世界BOSS(小丑)", log, genericCtrl: bGeneric);
            }
            else log.AppendLine("未发现小丑模型，世界BOSS沿用怪物模型");

            // 次元专属英雄：① 关键词精确匹配已知购买包 → ② 剩余次元从未占用英雄里各分一个（保证每次元外观不同）
            // 写 Resources/DW/hero_{dim}，运行时优先级最高。角色越多分配越精确。
            log.AppendLine("\n--- 次元专属英雄分配 ---");
            var usedForDim = new HashSet<string>();
            string PickDim(string dim, System.Func<string, bool> match, string note)
            {
                var src = heroSrcs.FirstOrDefault((p) => !usedForDim.Contains(p) && match(p));
                if (src == null) return null;
                SaveCharPrefab(src, $"{ResDir}/hero_{dim}.prefab", ctrl, $"次元英雄[{dim}]{note}", log, forceHuman: true);
                usedForDim.Add(src);
                return src;
            }
            // ① 已知包按主题精确分配
            foreach (var (dim, match) in DimHeroRules) PickDim(dim, match, "");
            // ② 其余次元：从尚未占用的英雄里各取一个不同形象（用上更多角色）
            foreach (var dim in DimOrder)
            {
                if (AssetDatabase.LoadAssetAtPath<GameObject>($"{ResDir}/hero_{dim}.prefab") != null) continue;
                if (PickDim(dim, (p) => true, " (自动分配)") == null)
                    log.AppendLine($"[{dim}] 可用角色已分完 → 运行时回退共享角色池");
            }

            // ③ 按「次元×职业」分配：每次元 5 职业各一个不同模型，用上所有角色（含兔女郎）；运行时 hero_{dim}_{cls} 优先级最高
            log.AppendLine("--- 次元×职业 英雄分配 ---");
            string[] classOrder = { "warrior", "assassin", "ranger", "tank", "healer" };
            var pin = new Dictionary<string, string[]>
            {
                { "xiuxian/warrior",  new[]{ "wukong", "悟空" } },
                { "xiuxian/healer",   new[]{ "bunny", "兔" } },          // 兔女郎 = 修仙奶妈（用户指定）
                { "xiuxian/assassin", new[]{ "huli", "fox", "狐狸" } },   // 狐狸 = 修仙刺客（用户指定）
                { "magic/healer",     new[]{ "nun", "修女" } },
                { "magic/warrior",    new[]{ "half_blood" } },
                { "magic/assassin",   new[]{ "servant", "church" } },
                { "tech/warrior",     new[]{ "girlv1", "girl_v.1" } },
                { "cyber/warrior",    new[]{ "girlv2", "girl_v.2" } },
                { "hunter/ranger",    new[]{ "cowboy", "sheriff", "牛仔" } },
            };
            int rot2 = 0;
            foreach (var dim in DimOrder)
            {
                var usedHere = new HashSet<string>();
                foreach (var cls in classOrder)
                {
                    string src = null;
                    if (pin.TryGetValue($"{dim}/{cls}", out var keys))
                        src = heroSrcs.FirstOrDefault((p) => !usedHere.Contains(p) && Has(p, keys));
                    if (src == null && heroSrcs.Count > 0)
                        for (int k = 0; k < heroSrcs.Count; k++)
                        {
                            var cand = heroSrcs[(rot2 + k) % heroSrcs.Count];
                            if (!usedHere.Contains(cand)) { src = cand; rot2++; break; }
                        }
                    if (src == null) continue;
                    usedHere.Add(src);
                    SaveCharPrefab(src, $"{ResDir}/hero_{dim}_{cls}.prefab", ctrl,
                        $"次元×职业[{dim}/{cls}] {Path.GetFileNameWithoutExtension(src)}", log, forceHuman: true);
                }
            }

            // 狐狸 FBX 不带贴图（贴图是松散 PNG）→ 建 Standard 材质贴上去，修白模
            ApplyHuliMaterial(log);

            // 英雄池 DWHeroes/h_XX（运行时按「次元×职业」组合取用的兜底，用上全部人物 + 未来未知购买包）
            RebuildFolder(HeroDir);
            int hi = 0;
            foreach (var src in heroSrcs)
                SaveCharPrefab(src, $"{HeroDir}/h_{hi++:00}.prefab", ctrl, $"英雄池#{hi} {System.IO.Path.GetFileNameWithoutExtension(src)}", log, forceHuman: true);
            if (hi == 0) log.AppendLine("⚠ 英雄池为空，英雄将用占位小人");

            // 怪物池 DWMobs/mob_XX（骷髅等，运行时按怪物id稳定取用）
            RebuildFolder(MobDir);
            int mi = 0;
            foreach (var src in monSrcs)
                SaveCharPrefab(src, $"{MobDir}/mob_{mi++:00}.prefab", ctrl, $"怪物池#{mi} {System.IO.Path.GetFileNameWithoutExtension(src)}", log);
            if (mi == 0) log.AppendLine("未发现骷髅/怪物类角色，怪物沿用 KayKit 默认模型");

            // 场景池 DWScene/sc_XX（你买的静态场景模型，如黑暗地牢的柱子/石棺/木桶等；地图据此散布）
            RebuildFolder(SceneDir);
            int si = 0; _propTexN = 0; _propColN = 0;
            foreach (var src in SceneryProps())
            {
                var go = AssetDatabase.LoadAssetAtPath<GameObject>(src);
                if (go == null) continue;
                var inst = (GameObject)Object.Instantiate(go);
                RecoverProps(inst);   // URP 材质→Built-in 顶点色，保留原贴图/颜色（修地图道具发白/发绿）
                PrefabUtility.SaveAsPrefabAsset(inst, $"{SceneDir}/sc_{si:00}.prefab");
                Object.DestroyImmediate(inst);
                log.AppendLine($"场景#{++si} ← {src}");
            }
            if (si > 0) log.AppendLine($"道具材质恢复：{_propTexN} 个用了原贴图(调色板)，{_propColN} 个用底色/自然色");
            if (si == 0) log.AppendLine("未发现可用场景模型，地图沿用 KayKit 道具");

            // 注意：不在这里自动接入 Hovl 特效——它在内置管线下常变粉。
            // 需要时单独点菜单「③ 接入Hovl特效」；默认用程序化特效（按次元配色，不会变粉）。

            AssetDatabase.SaveAssets();
            AssetDatabase.Refresh();
            Debug.Log(log.ToString());
            File.WriteAllText("Assets/DW_接入结果.txt", log.ToString());
            EditorUtility.DisplayDialog("次元大战",
                $"英雄池 {hi} 个 · 怪物池 {mi} 个 · BOSS{(bossSrcs.Count > 0 ? "(小丑)" : "无")}\n\n点 ▶ 运行查看。\n把 Assets/DW_接入结果.txt 发给 Claude 可精调分配。", "好");
        }

        [MenuItem("次元大战/③ 接入Hovl特效(变粉就别用)")]
        public static void WireFxMenu()
        {
            var log = new StringBuilder("===== 接入 Hovl 特效 =====\n");
            WireFx(log);
            AssetDatabase.SaveAssets(); AssetDatabase.Refresh();
            Debug.Log(log.ToString());
            EditorUtility.DisplayDialog("次元大战",
                log.ToString() + "\n\n进游戏看技能特效：若变粉，删掉 Assets/Resources/DWFx 文件夹即回到程序化特效（按次元配色，不会粉）。", "好");
        }

        /* 批量复制某文件夹下的特效到 Resources/DWFx/{name}{i}，供运行时按技能散列取用 */
        static int CopyPool(StringBuilder log, string name, string folder, int max, string contains = null)
        {
            if (!AssetDatabase.IsValidFolder(folder)) return 0;
            int i = 0;
            foreach (var g in AssetDatabase.FindAssets("t:GameObject", new[] { folder }))
            {
                if (i >= max) break;
                var p = AssetDatabase.GUIDToAssetPath(g);
                if (!p.EndsWith(".prefab")) continue;
                if (contains != null && !Path.GetFileName(p).Contains(contains)) continue;
                if (AssetDatabase.LoadAssetAtPath<GameObject>(p) == null) continue;
                if (AssetDatabase.CopyAsset(p, $"Assets/Resources/DWFx/{name}{i}.prefab")) i++;
            }
            log.AppendLine($"特效池[{name}] 复制 {i} 个");
            return i;
        }

        /* 取某文件夹里第一个 .prefab（用于扫描"剑斩特效"这类包，不必知道具体文件名） */
        static string FirstPrefabIn(string folder)
        {
            if (!AssetDatabase.IsValidFolder(folder)) return null;
            foreach (var g in AssetDatabase.FindAssets("t:GameObject", new[] { folder }))
            {
                var p = AssetDatabase.GUIDToAssetPath(g);
                if (p.EndsWith(".prefab") && AssetDatabase.LoadAssetAtPath<GameObject>(p) != null) return p;
            }
            return null;
        }

        /* 把选定的 Hovl 特效复制进 Resources/DWFx，供运行时按名加载（缺失则运行时程序化兜底） */
        static void WireFx(StringBuilder log)
        {
            const string aaa = "Assets/Hovl Studio/AAA Projectiles Vol 1/Prefabs/";
            // 专门的剑斩包：扫描其 Prefabs 取首个，优先用它做近战/突进的剑斩特效
            var sword = FirstPrefabIn("Assets/Hovl Studio/Sword slash VFX/Prefabs");
            var slashCands = sword != null
                ? new[] { sword, "Assets/Hovl Studio/AOE Magic spells Vol.1/Prefabs/Flower slash.prefab" }
                : new[] { "Assets/Hovl Studio/AOE Magic spells Vol.1/Prefabs/Flower slash.prefab" };
            var map = new List<(string name, string[] cands)>
            {
                // 通用兜底（次元变体缺失时用）
                ("proj",      new[]{ aaa + "Projectiles(transform)/Projectile 16 fire.prefab", aaa + "Projectiles(transform)/Projectile 5 red.prefab" }),
                ("hit",       new[]{ aaa + "Flash and hits/Hit 16 fire.prefab", aaa + "Flash and hits/Hit 5 red.prefab" }),
                ("cast",      new[]{ aaa + "Flash and hits/Flash 17 nova violet.prefab", aaa + "Flash and hits/Flash 5 red.prefab" }),
                ("aoe",       new[]{ "Assets/Hovl Studio/AOE Magic spells Vol.1/Prefabs/Energy explosion.prefab", "Assets/Hovl Studio/AOE Magic spells Vol.1/Prefabs/Magic attack.prefab" }),
                ("heal",      new[]{ "Assets/Hovl Studio/AOE Magic spells Vol.1/Prefabs/Leaves buff.prefab" }),
                ("shield",    new[]{ "Assets/Hovl Studio/Magic circles/Prefabs/Magic shield holy.prefab", "Assets/Hovl Studio/Magic circles/Prefabs/Magic shield runes.prefab" }),
                ("circle",    new[]{ "Assets/Hovl Studio/Magic circles/Prefabs/Magic circle octagon.prefab", "Assets/Hovl Studio/Magic circles/Prefabs/Magic circle sun.prefab" }),
                ("slash",     slashCands),
                ("storm",     new[]{ "Assets/Hovl Studio/AOE Magic spells Vol.1/Prefabs/Meteor shower.prefab", "Assets/Hovl Studio/AOE Magic spells Vol.1/Prefabs/Meteor shower 2.prefab" }),
                ("lightning", new[]{ "Assets/Hovl Studio/AOE Magic spells Vol.1/Prefabs/Lightning strike.prefab" }),
            };
            // 五次元各用不同元素主题的弹道/施法/击中（科技=电/赛博=红激光/修仙=自然/魔法=紫华/猎人=橙箭）
            var dimElem = new[] { ("tech", "2 electro"), ("cyber", "13 red laser"), ("xiuxian", "1 nature arrow"), ("magic", "17 nova violet"), ("hunter", "11 orange arrow") };
            foreach (var (dim, en) in dimElem)
            {
                map.Add(($"proj_{dim}", new[]{ aaa + $"Projectiles(transform)/Projectile {en}.prefab" }));
                map.Add(($"cast_{dim}", new[]{ aaa + $"Flash and hits/Flash {en}.prefab" }));
                map.Add(($"hit_{dim}",  new[]{ aaa + $"Flash and hits/Hit {en}.prefab" }));
            }
            const string fxDir = "Assets/Resources/DWFx";
            RebuildFolder(fxDir);
            int n = 0;
            foreach (var (name, cands) in map)
            {
                var src = cands.FirstOrDefault((c) => AssetDatabase.LoadAssetAtPath<GameObject>(c) != null);
                if (src == null) { log.AppendLine($"特效[{name}] 未找到 Hovl 源 → 运行时程序化兜底"); continue; }
                if (AssetDatabase.CopyAsset(src, $"{fxDir}/{name}.prefab")) { log.AppendLine($"特效[{name}] ← {src}"); n++; }
                else log.AppendLine($"特效[{name}] 复制失败：{src}");
            }
            // 特效池：成批复制，运行时按「次元+职业+技能」散列各取不同特效（尽量用上整套 Hovl）
            const string aoeF = "Assets/Hovl Studio/AOE Magic spells Vol.1/Prefabs";
            const string flashF = aaa + "Flash and hits";
            // 通用兜底池
            CopyPool(log, "fxp_slash", "Assets/Hovl Studio/Sword slash VFX/Prefabs", 60);   // 整包剑斩全用上
            CopyPool(log, "fxp_aoe", aoeF, 18);
            CopyPool(log, "fxp_cast", flashF, 16, "Flash ");
            CopyPool(log, "fxp_buff", "Assets/Hovl Studio/Magic circles/Prefabs", 18);
            // 次元元素专属：远程施法闪光（按元素）
            foreach (var (dim, e) in new[] { ("tech", "electro"), ("cyber", "red laser"), ("xiuxian", "nature"), ("magic", "nova"), ("hunter", "orange") })
                CopyPool(log, $"fxp_cast_{dim}", flashF, 8, e);
            // 次元元素专属：范围魔法（科技=闪电/赛博=飞刀/修仙=自然尖刺/魔法=能量/猎人=陨石）
            CopyPool(log, "fxp_aoe_tech", aoeF, 6, "Lightning");
            CopyPool(log, "fxp_aoe_cyber", aoeF, 6, "Kni");
            CopyPool(log, "fxp_aoe_xiuxian", aoeF, 6, "spikes");
            CopyPool(log, "fxp_aoe_magic", aoeF, 6, "Magic");
            CopyPool(log, "fxp_aoe_hunter", aoeF, 6, "Meteor");
            log.AppendLine(n == 0 ? "未接入命名 Hovl 特效（程序化兜底）" : $"已接入 {n} 个命名 Hovl 特效 + 特效池到 Resources/DWFx");
        }

        /* 清空并重建文件夹（去掉上次生成的预制体） */
        static void RebuildFolder(string dir)
        {
            if (AssetDatabase.IsValidFolder(dir)) AssetDatabase.DeleteAsset(dir);
            Directory.CreateDirectory(dir);
            AssetDatabase.Refresh();
        }

        /* 按「角色」去重：每个角色只取一个最佳代表（优先 .prefab 而非裸 .fbx，优先 full，
         * 折叠颜色变体）。骷髅合集的 4 个子角色各在子目录 → 各算一个角色，都能用上。 */
        static List<string> DedupePacks(List<string> paths)
        {
            var res = new List<string>();
            foreach (var g in paths.GroupBy(CharFolder))
            {
                var items = g.ToList();
                var prefabs = items.Where((p) => Lower(p).EndsWith(".prefab")).ToList();
                var pool = prefabs.Count > 0 ? prefabs : items;   // 有 prefab 就不要裸模型（裸模型常缺材质）
                var seen = new HashSet<string>();
                foreach (var p in pool.OrderByDescending((x) => Lower(x).Contains("full") ? 1 : 0))
                    if (seen.Add(NormBase(p))) res.Add(p);          // 同一角色的颜色变体只留一个
            }
            return res;
        }

        static string TopFolder(string p)
        {
            var parts = p.Split('/');
            return parts.Length >= 2 ? parts[0] + "/" + parts[1] : p;
        }

        /* 角色目录：去掉末级的 Prefab / Base Mesh / Meshes / Model / Animations 等，
         * 使「同一角色的 fbx 与 prefab」「不同管线变体」归到同一组，而不同子角色各自成组。 */
        static string CharFolder(string p)
        {
            int slash = p.LastIndexOf('/');
            var dir = slash > 0 ? p.Substring(0, slash) : p;
            var low = Lower(dir);
            foreach (var lf in new[] { "/prefab_urp", "/prefab_hdrp", "/prefab", "/prefabs", "/base mesh", "/base_mesh", "/basemesh", "/meshes", "/mesh", "/models", "/model", "/animations", "/anim" })
                if (low.EndsWith(lf)) return dir.Substring(0, dir.Length - lf.Length);
            return dir;
        }

        /* 去掉颜色/编号/管线/部件后缀，得到角色基名，用于折叠同角色的变体 */
        static string NormBase(string p)
        {
            var n = Lower(Path.GetFileNameWithoutExtension(p));
            for (int i = 0; i < 6; i++)
            {
                var before = n;
                n = Regex.Replace(n, @"\s*\(\d+\)$", "");          // " (1)"
                n = Regex.Replace(n, @"[ _]?\d+$", "");            // 结尾编号
                foreach (var s in new[] { "_full", "_unity", "_body", "_opac", "_opacity", "_skin", " skin" })
                    if (n.EndsWith(s)) n = n.Substring(0, n.Length - s.Length);
                if (n == before) break;
            }
            return n.Trim('_', ' ');
        }

        /* 该排除的预制体：URP/HDRP 管线变体（内置渲染管线会粉红）、残缺部件/透明体 */
        static bool BadPrefabVariant(string p)
        {
            var lp = Lower(p);
            if (lp.Contains("/prefab_hdrp/") || lp.Contains("/prefab_urp/") || lp.Contains("_hdrp") || lp.Contains("_urp")) return true;
            var n = Lower(Path.GetFileNameWithoutExtension(p));
            if (n.Contains("censore")) return true;
            // 残缺/透明工具体（但保留 *_full）
            if (!n.EndsWith("_full") && (n.EndsWith("_body") || n.EndsWith("_opac") || n.EndsWith("_opacity") || n.EndsWith("_body_opac") || n.EndsWith("_body_opacity"))) return true;
            return false;
        }

        /* 把一个角色源复制成标准命名 Prefab 并挂动画控制器。
         * forceHuman：源若是 Generic 骨骼（如 Sci-Fi 士兵），自动把其 FBX 导入设置转 Humanoid
         * 并重导入，使其能重定向通用人形动作——否则站桩 T-Pose。 */
        static void SaveCharPrefab(string src, string dst, AnimatorController ctrl, string label, StringBuilder log, bool forceHuman = false, bool genericCtrl = false)
        {
            AssetDatabase.DeleteAsset(dst);
            var srcGo = AssetDatabase.LoadAssetAtPath<GameObject>(src);
            if (srcGo == null) { log.AppendLine($"{label}：加载失败 {src}"); return; }
            bool human = HasHumanAvatar(srcGo);
            if (forceHuman && !human)
            {
                var av = EnsureHumanoidAvatar(srcGo, log);
                human = av != null;
                srcGo = AssetDatabase.LoadAssetAtPath<GameObject>(src);   // 重导入后重新加载
            }
            var inst = (GameObject)Object.Instantiate(srcGo);
            var animator = inst.GetComponentInChildren<Animator>();
            if (animator == null) animator = inst.AddComponent<Animator>();
            if (animator.avatar == null || !animator.avatar.isHuman)
            {
                var av = FindHumanAvatar(srcGo);                          // 转换后头像在 FBX 子资源里
                if (av != null) { animator.avatar = av; human = true; }
            }
            // 人形→共享人形控制器（重定向）；Generic→自己包的通用控制器（genericCtrl）
            bool attached = ctrl != null && (human || genericCtrl);
            if (attached) animator.runtimeAnimatorController = ctrl;
            PrefabUtility.SaveAsPrefabAsset(inst, dst);
            Object.DestroyImmediate(inst);
            log.AppendLine($"{label} ← {src}  动画:{(attached ? "已挂" : "静态(无人形骨骼)")}");
        }

        static bool HasHumanAvatar(GameObject go)
        {
            var an = go.GetComponentInChildren<Animator>(true);
            return an != null && an.avatar != null && an.avatar.isHuman;
        }

        /* 从模型 FBX 的子资源里取人形 Avatar */
        static Avatar FindHumanAvatar(GameObject srcGo)
        {
            var smr = srcGo.GetComponentInChildren<SkinnedMeshRenderer>(true);
            if (smr == null || smr.sharedMesh == null) return null;
            var meshPath = AssetDatabase.GetAssetPath(smr.sharedMesh);
            foreach (var a in AssetDatabase.LoadAllAssetsAtPath(meshPath))
                if (a is Avatar av && av.isHuman) return av;
            return null;
        }

        /* 把源模型的导入骨骼类型改为 Humanoid 并重导入，返回生成的人形 Avatar（失败返回 null） */
        static Avatar EnsureHumanoidAvatar(GameObject srcGo, StringBuilder log)
        {
            var smr = srcGo.GetComponentInChildren<SkinnedMeshRenderer>(true);
            if (smr == null || smr.sharedMesh == null) return null;
            var meshPath = AssetDatabase.GetAssetPath(smr.sharedMesh);
            var imp = AssetImporter.GetAtPath(meshPath) as ModelImporter;
            if (imp == null) return null;
            if (imp.animationType != ModelImporterAnimationType.Human)
            {
                imp.animationType = ModelImporterAnimationType.Human;
                imp.avatarSetup = ModelImporterAvatarSetup.CreateFromThisModel;
                imp.SaveAndReimport();
                log.AppendLine($"  ↳ 已将 {Path.GetFileName(meshPath)} 转为 Humanoid 骨骼并重导入");
            }
            var av = FindHumanAvatar(AssetDatabase.LoadAssetAtPath<GameObject>(meshPath));
            if (av == null) log.AppendLine($"  ⚠ {Path.GetFileName(meshPath)} 自动 Humanoid 失败，可能需手动在导入设置里配 Avatar");
            return av;
        }

        /* 全项目角色资源（含 .prefab 与导入的 .fbx/.obj 模型，如悟空只有 FBX）：
         * 带蒙皮网格、人形优先、完整版优先、排除自己生成的 Resources/DW */
        static List<string> AllCharacterPrefabs()
        {
            return AssetDatabase.FindAssets("t:GameObject")
                .Select(AssetDatabase.GUIDToAssetPath)
                .Where((p) => p.StartsWith("Assets/") && !p.StartsWith("Assets/Resources/"))
                .Where((p) => !Lower(p).EndsWith(".blend"))   // 排除 .blend 源文件（会与 .fbx 重复导入、且常含多个网格→“两只”）
                .Where((p) => !BadPrefabVariant(p))   // 排除 URP/HDRP（内置管线会变粉）与残缺部件
                .Where((p) => {
                    var go = AssetDatabase.LoadAssetAtPath<GameObject>(p);
                    if (go == null || go.GetComponentInChildren<SkinnedMeshRenderer>(true) == null) return false;
                    if (IsEffectPrefab(p)) return false;                                       // 排除特效/水体（如 FX_Waterfall）
                    if (go.GetComponentInChildren<ParticleSystem>(true) != null) return false; // 带粒子=特效，不是角色
                    return true;
                })
                .OrderByDescending((p) => {
                    var go = AssetDatabase.LoadAssetAtPath<GameObject>(p);
                    var an = go.GetComponentInChildren<Animator>(true);
                    return (an != null && an.avatar != null && an.avatar.isHuman) ? 1 : 0;   // 人形优先
                })
                .ThenByDescending((p) => Lower(p).Contains("full") ? 1 : 0)
                .ToList();
        }

        /* 用某个包自己的动作片段搭 Generic 控制器（如小丑：Generic 骨骼+自带动作） */
        static AnimatorController BuildGenericController(string packFolder, string keySuffix, StringBuilder log)
        {
            var states = PickStates(AllClips(packFolder));
            if (states.Count == 0) { log.AppendLine($"  ⚠ {packFolder} 无可用动作，BOSS 将静态展示"); return null; }
            var path = $"{ResDir}/dw_gen_{keySuffix}.controller";
            AssetDatabase.DeleteAsset(path);
            var ctrl = AnimatorController.CreateAnimatorControllerAtPath(path);
            var sm = ctrl.layers[0].stateMachine;
            foreach (var kv in states)
            {
                var st = sm.AddState(kv.Key);
                st.motion = kv.Value;
                if (kv.Key == "Idle") sm.defaultState = st;
                log.AppendLine($"  小丑动画 {kv.Key} ← {kv.Value.name}");
            }
            return ctrl;
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

        /* 文件夹内是否有人形(Humanoid)动作片段——决定能否把这套动作套到所有人形英雄上 */
        static bool FolderHasHumanClip(string folder)
        {
            foreach (var c in AllClips(folder)) if (c.isHumanMotion) return true;
            return false;
        }

        /* 狐狸 FBX 不带贴图（贴图是松散 PNG）→ 建 Standard 材质贴上 basecolor/normal/metalrough，
         * 应用到修仙刺客英雄预制体，修复白模。 */
        static void ApplyHuliMaterial(StringBuilder log)
        {
            string folder = FindFolder("huli", "fox", "狐狸");
            if (folder == null) return;
            Texture2D Find(params string[] keys)
            {
                foreach (var g in AssetDatabase.FindAssets("t:Texture2D", new[] { folder }))
                {
                    var p = AssetDatabase.GUIDToAssetPath(g);
                    foreach (var k in keys) if (Lower(p).Contains(k)) return AssetDatabase.LoadAssetAtPath<Texture2D>(p);
                }
                return null;
            }
            var baseTex = Find("basecolor", "颜色", "albedo", "diffuse", "basecol");
            if (baseTex == null) { log.AppendLine("⚠ 狐狸未找到 basecolor 贴图，仍为白模"); return; }
            var normTex = Find("normal", "法线", "_nrm");
            var mrTex = Find("metalrough", "金属粗糙", "金属", "metallic", "_mr");
            SetTexImport(baseTex, sRGB: true, normal: false);          // 颜色贴图按 sRGB
            if (normTex != null) SetTexImport(normTex, sRGB: false, normal: true);
            var mat = new Material(Shader.Find("DW/DoubleSided") ?? Shader.Find("Standard"));   // 双面，修布料破洞
            mat.SetTexture("_MainTex", baseTex);
            if (normTex != null) { mat.EnableKeyword("_NORMALMAP"); mat.SetTexture("_BumpMap", normTex); mat.SetFloat("_BumpScale", 1f); }
            // metalrough(glTF: G=粗糙度, B=金属度) → Unity _MetallicGlossMap(R=金属, A=光滑=1-粗糙)
            var mg = mrTex != null ? RepackMetalRough(mrTex, log) : null;
            if (mg != null) { mat.EnableKeyword("_METALLICGLOSSMAP"); mat.SetTexture("_MetallicGlossMap", mg); mat.SetFloat("_GlossMapScale", 1f); }
            else { mat.SetFloat("_Metallic", 0f); mat.SetFloat("_Glossiness", 0.3f); }   // 兜底：哑光毛发
            var matPath = ResDir + "/mat_huli.mat";
            AssetDatabase.DeleteAsset(matPath);
            AssetDatabase.CreateAsset(mat, matPath);
            var prefabPath = $"{ResDir}/hero_xiuxian_assassin.prefab";
            if (AssetDatabase.LoadAssetAtPath<GameObject>(prefabPath) == null) { log.AppendLine("⚠ 未找到 hero_xiuxian_assassin，狐狸材质未应用"); return; }
            var root = PrefabUtility.LoadPrefabContents(prefabPath);
            foreach (var r in root.GetComponentsInChildren<Renderer>(true))
            {
                var arr = new Material[r.sharedMaterials.Length == 0 ? 1 : r.sharedMaterials.Length];
                for (int i = 0; i < arr.Length; i++) arr[i] = mat;
                r.sharedMaterials = arr;
            }
            PrefabUtility.SaveAsPrefabAsset(root, prefabPath);
            PrefabUtility.UnloadPrefabContents(root);
            log.AppendLine($"✓ 狐狸材质已贴：albedo={baseTex.name}{(normTex != null ? " +法线" : "")}{(mrTex != null ? " +金属粗糙" : "")}");
        }

        /* 设贴图导入参数：法线/sRGB */
        static void SetTexImport(Texture2D tex, bool sRGB, bool normal)
        {
            var imp = AssetImporter.GetAtPath(AssetDatabase.GetAssetPath(tex)) as TextureImporter;
            if (imp == null) return;
            bool dirty = false;
            if (normal) { if (imp.textureType != TextureImporterType.NormalMap) { imp.textureType = TextureImporterType.NormalMap; dirty = true; } }
            else
            {
                if (imp.textureType != TextureImporterType.Default) { imp.textureType = TextureImporterType.Default; dirty = true; }
                if (imp.sRGBTexture != sRGB) { imp.sRGBTexture = sRGB; dirty = true; }
            }
            if (dirty) imp.SaveAndReimport();
        }

        /* glTF metalrough(G=粗糙度,B=金属度) 重打包为 Unity Standard 的 _MetallicGlossMap(R=金属,A=光滑=1-粗糙) */
        static Texture2D RepackMetalRough(Texture2D mrTex, StringBuilder log)
        {
            try
            {
                var path = AssetDatabase.GetAssetPath(mrTex);
                var imp = AssetImporter.GetAtPath(path) as TextureImporter;
                if (imp != null && (!imp.isReadable || imp.sRGBTexture)) { imp.isReadable = true; imp.sRGBTexture = false; imp.SaveAndReimport(); }
                var src = AssetDatabase.LoadAssetAtPath<Texture2D>(path);
                var px = src.GetPixels();
                for (int i = 0; i < px.Length; i++) { var c = px[i]; px[i] = new Color(c.b, c.b, c.b, 1f - c.g); }
                var packed = new Texture2D(src.width, src.height, TextureFormat.RGBA32, false);
                packed.SetPixels(px); packed.Apply();
                var outPath = ResDir + "/huli_metalgloss.png";
                System.IO.File.WriteAllBytes(outPath, packed.EncodeToPNG());
                UnityEngine.Object.DestroyImmediate(packed);
                AssetDatabase.ImportAsset(outPath);
                var pimp = AssetImporter.GetAtPath(outPath) as TextureImporter;
                if (pimp != null) { pimp.sRGBTexture = false; pimp.SaveAndReimport(); }
                log.AppendLine("✓ metalrough 已重打包为 Unity 金属/光滑贴图");
                return AssetDatabase.LoadAssetAtPath<Texture2D>(outPath);
            }
            catch (System.Exception e) { log.AppendLine("⚠ metalrough 重打包失败:" + e.Message + "，改用哑光默认"); return null; }
        }

        /* 把场景道具的 URP/不兼容材质转成 Built-in 顶点色，并用 SerializedObject 读回原贴图/颜色——
         * 编辑器里即使 shader 不被支持，也能从序列化数据读到原贴图(调色板)/底色，从而还原低多边形包的颜色。 */
        static Shader _vcShaderE;
        static int _propTexN, _propColN;
        static void RecoverProps(GameObject inst)
        {
            if (_vcShaderE == null) _vcShaderE = Shader.Find("DW/VertexColor") ?? Shader.Find("Standard");
            foreach (var r in inst.GetComponentsInChildren<Renderer>(true))
            {
                var mats = r.sharedMaterials;
                var arr = new Material[mats.Length];
                bool changed = false;
                for (int i = 0; i < mats.Length; i++)
                {
                    var m = mats[i];
                    if (m == null) { arr[i] = m; continue; }
                    var sh = m.shader;
                    bool ok = sh != null && sh.isSupported && sh.name != "Hidden/InternalErrorShader"
                              && !sh.name.StartsWith("Universal Render Pipeline") && !sh.name.StartsWith("HDRP");
                    if (ok) { arr[i] = m; continue; }   // 已是兼容材质，保留原样
                    var fix = new Material(_vcShaderE);
                    var tex = MatTex(m, "_BaseMap", "_MainTex", "_BaseColorMap");
                    if (tex != null) { fix.SetTexture("_MainTex", tex); fix.color = Color.white; _propTexN++; }
                    else
                    {
                        var col = MatColor(m, "_BaseColor", "_Color");
                        if (col.r > 0.92f && col.g > 0.92f && col.b > 0.92f) col = NaturalColorE(inst.name + " " + r.name + " " + m.name);
                        fix.color = col; _propColN++;
                    }
                    arr[i] = fix; changed = true;
                }
                if (changed) r.sharedMaterials = arr;
            }
        }
        // 读不回原色时按名字给自然色（编辑器版，与运行时一致）
        static Color NaturalColorE(string name)
        {
            string n = name.ToLowerInvariant();
            if (n.Contains("trunk") || n.Contains("bark") || n.Contains("log") || n.Contains("wood") || n.Contains("stump") || n.Contains("branch")) return new Color(0.46f, 0.32f, 0.19f);
            if (n.Contains("leaf") || n.Contains("foliage") || n.Contains("bush") || n.Contains("tree") || n.Contains("pine") || n.Contains("fern") || n.Contains("plant") || n.Contains("grass")) return new Color(0.30f, 0.46f, 0.22f);
            if (n.Contains("rock") || n.Contains("stone") || n.Contains("cliff") || n.Contains("boulder")) return new Color(0.52f, 0.53f, 0.5f);
            return new Color(0.55f, 0.57f, 0.55f);
        }
        static Texture MatTex(Material m, params string[] names)
        {
            var so = new SerializedObject(m);
            var te = so.FindProperty("m_SavedProperties.m_TexEnvs");
            if (te == null) return null;
            Texture any = null;
            for (int i = 0; i < te.arraySize; i++)
            {
                var el = te.GetArrayElementAtIndex(i);
                var key = el.FindPropertyRelative("first");
                if (key == null) continue;
                var t = el.FindPropertyRelative("second.m_Texture");
                var tx = t != null ? t.objectReferenceValue as Texture : null;
                if (tx == null) continue;
                foreach (var n in names) if (key.stringValue == n) return tx;     // 指定名优先
                var kl = key.stringValue.ToLowerInvariant();
                if (any == null && !kl.Contains("bump") && !kl.Contains("normal") && !kl.Contains("metal") && !kl.Contains("mask")) any = tx;
            }
            return any;   // 兜底：任意非法线/金属贴图（多为调色板）
        }
        static Color MatColor(Material m, params string[] names)
        {
            var so = new SerializedObject(m);
            var cs = so.FindProperty("m_SavedProperties.m_Colors");
            if (cs != null)
                for (int i = 0; i < cs.arraySize; i++)
                {
                    var el = cs.GetArrayElementAtIndex(i);
                    var key = el.FindPropertyRelative("first");
                    if (key == null) continue;
                    foreach (var n in names) if (key.stringValue == n) return el.FindPropertyRelative("second").colorValue;
                }
            return Color.white;
        }

        /* 把文件夹内所有模型/动作 FBX 的导入骨骼改为 Humanoid 并重导（让狐狸动作可套到人形英雄） */
        static void ForceFolderHumanoid(string folder, StringBuilder log)
        {
            foreach (var guid in AssetDatabase.FindAssets("t:Model", new[] { folder }))
            {
                var path = AssetDatabase.GUIDToAssetPath(guid);
                var imp = AssetImporter.GetAtPath(path) as ModelImporter;
                if (imp == null || imp.animationType == ModelImporterAnimationType.Human) continue;
                imp.animationType = ModelImporterAnimationType.Human;
                imp.avatarSetup = ModelImporterAvatarSetup.CreateFromThisModel;
                try { imp.SaveAndReimport(); log.AppendLine($"  ↳ 狐狸:{Path.GetFileName(path)} → Humanoid"); }
                catch (System.Exception e) { log.AppendLine($"  ⚠ {Path.GetFileName(path)} 转人形失败:{e.Message}"); }
            }
        }

        /* 按动作名关键词挑选状态片段（关键词按优先级排序，越靠前越优先匹配） */
        static Dictionary<string, AnimationClip> PickStates(List<AnimationClip> clips)
        {
            // 4 个技能用尽量不同的动作：Attack1/Attack2/Skill/Skill2
            var rules = new (string state, string[] keys)[]
            {
                ("Idle",    new[] { "idle", "stand" }),
                ("Run",     new[] { "jog", "run", "sprint", "walk" }),
                ("Attack1", new[] { "attack1", "attackl", "attack_l", "attack", "slash", "1h_melee", "punch" }),
                ("Attack2", new[] { "attack2", "attackr", "attack_r", "stab", "spin", "2h_melee", "dualwield" }),
                ("Skill",   new[] { "spellcast", "cast", "skill", "spell", "shoot", "heavy", "rage", "chest" }),
                ("Skill2",  new[] { "spellcast2", "dance", "pickup", "spellcast_long", "attack3", "attack4" }),
                ("Dodge",   new[] { "roll", "dodge", "dash" }),
                ("Death",   new[] { "death", "die", "dead" }),
            };
            var res = new Dictionary<string, AnimationClip>();
            var taken = new HashSet<AnimationClip>();
            foreach (var (state, keys) in rules)
            {
                foreach (var k in keys)
                {
                    var hit = clips.FirstOrDefault((c) => Lower(c.name).Contains(k) && !taken.Contains(c));
                    if (hit != null) { res[state] = hit; taken.Add(hit); break; }
                }
            }
            // 兜底：缺的技能动作依次回退，保证不同键尽量不同
            if (!res.ContainsKey("Attack1") && res.ContainsKey("Attack2")) res["Attack1"] = res["Attack2"];
            if (!res.ContainsKey("Attack2") && res.ContainsKey("Attack1")) res["Attack2"] = res["Attack1"];
            if (!res.ContainsKey("Skill")) res["Skill"] = res.ContainsKey("Attack2") ? res["Attack2"] : res.GetValueOrDefault("Attack1");
            if (!res.ContainsKey("Skill2")) res["Skill2"] = res.ContainsKey("Skill") ? res["Skill"] : res.GetValueOrDefault("Attack1");
            res = res.Where((kv) => kv.Value != null).ToDictionary((kv) => kv.Key, (kv) => kv.Value);
            return res;
        }
    }
}
