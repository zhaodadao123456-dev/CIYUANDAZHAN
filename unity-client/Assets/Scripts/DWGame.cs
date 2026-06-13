/* ============================================================
 * 次元大战 Unity 客户端 - 主逻辑
 * 自动启动（无需配置场景），连接 dimensional-war-3d 服务器
 * 操作：WASD移动 · 右键拖动转视角 · 滚轮缩放
 *       左键普攻 · Q/E/R技能 · 空格翻滚 · F捕捉(猎人) · B面板
 * ============================================================ */
using System;
using System.Collections.Generic;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using UnityEngine;

namespace DW
{
    public partial class Game : MonoBehaviour
    {
        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.AfterSceneLoad)]
        static void Boot()
        {
            var root = new GameObject("DW_Game");
            DontDestroyOnLoad(root);
            root.AddComponent<Game>();
        }

        enum State { Menu, Connecting, Playing }
        State state = State.Menu;

        Net net;
        Camera cam;
        Font cjkFont;

        // 登录选择
        string serverIp = "1.2.3.4";
        string playerName = "";
        int dimIdx = 1, clsIdx = 0;

        // 我的状态
        string myId, myDim, myCls, curRoom;
        Vector3 pos;
        float ry;
        bool meDead;
        float deadAt;
        GameObject meGo;
        DWAnimDriver meDrv;
        JObject you;            // 服务器下发的完整属性
        JObject warInfo;
        protected JObject bossInfo;
        protected JObject meleeInfo;
        protected JArray partyMembers;
        string inviteFrom;
        float inviteUntil;
        float shakeUntil, shakeAmp;
        JObject equipData;
        JArray invData, shopData;

        // 实体
        class Ent
        {
            public GameObject go;
            public TextMesh label;
            public Vector3 target;
            public float tRy;
            public int hp, maxHp, level, tier;
            public string name, dim, cls, anim = "idle";
            public bool dead, isMonster, isPet;
        }
        readonly Dictionary<string, Ent> players = new Dictionary<string, Ent>();
        readonly Dictionary<string, Ent> monsters = new Dictionary<string, Ent>();
        readonly Dictionary<string, Ent> pets = new Dictionary<string, Ent>();

        class Proj { public GameObject go; public Vector3 dir; public float speed, dieAt; }
        readonly Dictionary<string, Proj> projs = new Dictionary<string, Proj>();

        // 相机
        float camYaw, camPitch = 0.55f, camDist = 11f;

        // 技能冷却（Time.time 秒）
        readonly Dictionary<string, float> readyAt = new Dictionary<string, float>();
        float dodgeReadyAt, captureReadyAt;
        protected string dimSkillName = "捕捉";
        protected float dimSkillCd;
        float rootedUntil;
        float burstUntil, burstSpeed;
        Vector3 burstDir;
        float lastMvSent;

        readonly List<GameObject> worldObjs = new List<GameObject>();
        readonly List<string> feed = new List<string>();
        readonly List<float> feedAt = new List<float>();
        string toastMsg = "";
        float toastUntil;
        protected int levelUpLevel;
        protected float levelUpUntil;

        void Awake()
        {
            Application.targetFrameRate = 60;
            serverIp = PlayerPrefs.GetString("dw_ip", serverIp);
            playerName = PlayerPrefs.GetString("dw_name", "");
            dimIdx = PlayerPrefs.GetInt("dw_dim", 1);
            clsIdx = PlayerPrefs.GetInt("dw_cls", 0);
            // 中文字体（IMGUI/TextMesh 兜底，避免显示为方框）
            foreach (var fn in new[] { "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", "WenQuanYi Micro Hei" })
            {
                try { cjkFont = Font.CreateDynamicFontFromOSFont(fn, 16); if (cjkFont != null) break; }
                catch (Exception) { }
            }
            cam = Camera.main;
            if (cam == null)
            {
                var cgo = new GameObject("DW_Camera");
                cam = cgo.AddComponent<Camera>();
                cgo.AddComponent<AudioListener>();
            }
            cam.gameObject.tag = "MainCamera";
        }

        /* ================= 连接与消息 ================= */

        // 退出当前对局，断开连接并清场，回到次元选择界面
        void ExitToMenu()
        {
            CancelInvoke();
            try { net?.Close(); } catch (Exception) { }
            net = null; joinSent = false;
            foreach (var e in players.Values) if (e.go) Destroy(e.go);
            foreach (var e in monsters.Values) if (e.go) Destroy(e.go);
            foreach (var e in pets.Values) if (e.go) Destroy(e.go);
            foreach (var p in projs.Values) if (p.go) Destroy(p.go);
            players.Clear(); monsters.Clear(); pets.Clear(); projs.Clear();
            foreach (var o in worldObjs) if (o) Destroy(o);
            worldObjs.Clear();
            if (meGo) Destroy(meGo);
            panelOpen = false; chatOpen = false;
            state = State.Menu;
        }

        void Join()
        {
            PlayerPrefs.SetString("dw_ip", serverIp);
            PlayerPrefs.SetString("dw_name", playerName);
            PlayerPrefs.SetInt("dw_dim", dimIdx);
            PlayerPrefs.SetInt("dw_cls", clsIdx);
            PlayerPrefs.Save();
            myDim = Data.Dims[dimIdx].id;
            myCls = Data.Classes[clsIdx].id;
            state = State.Connecting;
            net = new Net();
            string host = serverIp.Contains(":") || serverIp.Contains("/") ? serverIp : serverIp + ":80";
            net.Connect($"ws://{host}/ws");
            InvokeRepeating(nameof(TrySendJoin), 0.2f, 0.4f);
        }

        bool joinSent;
        void TrySendJoin()
        {
            if (net == null) return;
            if (net.Closed && !net.Connected)
            {
                CancelInvoke(nameof(TrySendJoin));
                state = State.Menu;
                Toast("连接失败：" + net.LastError);
                return;
            }
            if (net.Connected && !joinSent)
            {
                joinSent = true;
                CancelInvoke(nameof(TrySendJoin));
                Send(new { t = "join", name = playerName, dim = myDim, cls = myCls });
            }
        }

        void Send(object o) => net?.Send(JsonConvert.SerializeObject(o));

        void Update()
        {
            // 处理网络消息
            if (net != null)
            {
                string raw;
                int guard = 0;
                while (net.Inbox.TryDequeue(out raw) && guard++ < 200)
                {
                    try { HandleMsg(JObject.Parse(raw)); }
                    catch (Exception e) { Debug.LogWarning("msg err: " + e.Message); }
                }
                if (state == State.Playing && net.Closed)
                {
                    // 断线自动重连重进
                    Toast("连接断开，正在重连…");
                    joinSent = false;
                    net = new Net();
                    string host = serverIp.Contains(":") ? serverIp : serverIp + ":80";
                    net.Connect($"ws://{host}/ws");
                    InvokeRepeating(nameof(TrySendJoin), 1f, 1f);
                    state = State.Connecting;
                }
            }
            if (state != State.Playing) return;

            UpdateInput();
            UpdateMove();
            UpdateEntities();
            UpdateCamera();
        }

        void HandleMsg(JObject m)
        {
            switch ((string)m["t"])
            {
                case "welcome":
                {
                    myId = (string)m["id"];
                    var youObj = (JObject)m["you"];
                    myDim = (string)youObj["dim"] ?? myDim;
                    if (youObj["cls"] != null) myCls = (string)youObj["cls"];
                    if (m["shop"] != null && m["shop"].Type == JTokenType.Array) shopData = (JArray)m["shop"];
                    if (m["equip"] != null) equipData = (JObject)m["equip"];
                    if (m["inv"] != null) invData = (JArray)m["inv"];
                    if (m["dimSkill"] != null)
                    {
                        dimSkillName = (string)m["dimSkill"]["name"] ?? "技能";
                        dimSkillCd = ((float?)m["dimSkill"]["cd"] ?? 3000) / 1000f;
                    }
                    EnterRoom((string)m["room"], m);
                    if (m["war"] != null) warInfo = (JObject)m["war"];
                    if (m["melee"] != null) meleeInfo = ((bool?)m["melee"]["active"] ?? false) ? (JObject)m["melee"] : null;
                    state = State.Playing;
                    break;
                }
                case "you": you = m; break;
                case "inv":
                    equipData = (JObject)m["equip"];
                    invData = (JArray)m["inv"];
                    break;
                case "snap": OnSnap(m); break;
                case "pjoin": AddPlayer((JObject)m["p"]); break;
                case "pleave": RemoveEnt(players, (string)m["id"]); break;
                case "proj":
                {
                    var color = (string)m["dim"] == "mon" ? new Color(1f, 0.27f, 0.27f) : Data.Dim((string)m["dim"]).accent;
                    SpawnProj((string)m["id"], (float)m["x"], (float)m["z"],
                        (float)m["dx"], (float)m["dz"], (float)m["speed"], color);
                    break;
                }
                case "projhit":
                {
                    Proj p;
                    if (projs.TryGetValue((string)m["id"], out p)) { Destroy(p.go); projs.Remove((string)m["id"]); }
                    break;
                }
                case "dmg": OnDmg(m); break;
                case "heal":
                {
                    var id = (string)m["id"];
                    Vector3 at = id == myId ? pos : (players.ContainsKey(id) ? players[id].target : pos);
                    FloatText("+" + (int)m["amt"], at, Color.green);
                    break;
                }
                case "mdie":
                {
                    Ent e;
                    if (monsters.TryGetValue((string)m["id"], out e)) { e.dead = true; e.go.SetActive(false); }
                    break;
                }
                case "mrespawn":
                {
                    Ent e;
                    if (monsters.TryGetValue((string)m["id"], out e))
                    {
                        e.dead = false; e.go.SetActive(true);
                        e.target = new Vector3((float)m["x"], 0, (float)m["z"]);
                        e.hp = (int)m["hp"];
                    }
                    break;
                }
                case "pdie":
                {
                    var id = (string)m["id"];
                    if (id == myId) { meDead = true; deadAt = Time.time; }
                    else { Ent e; if (players.TryGetValue(id, out e)) e.dead = true; }
                    break;
                }
                case "prespawn":
                {
                    var id = (string)m["id"];
                    if (id == myId)
                    {
                        meDead = false;
                        pos = new Vector3((float)m["x"], 0, (float)m["z"]);
                    }
                    else { Ent e; if (players.TryGetValue(id, out e)) e.dead = false; }
                    break;
                }
                case "lvl":
                    if ((string)m["id"] == myId)
                    {
                        levelUpLevel = (int)m["level"];
                        levelUpUntil = Time.time + 2.6f;
                        Shake(0.15f, 0.2f);
                    }
                    break;
                case "cast":
                {
                    Ent e;
                    if (players.TryGetValue((string)m["id"], out e))
                    {
                        e.tRy = Mathf.Atan2((float)m["dx"], (float)m["dz"]);
                        var drv = e.go != null ? e.go.GetComponent<DWAnimDriver>() : null;
                        if (drv != null) drv.PlayOnce((string)m["k"] == "basic" ? "Attack1" : "Skill", 0.6f);
                    }
                    break;
                }
                case "war":
                    if (m["state"] != null) warInfo = (JObject)m["state"];
                    break;
                case "boss":
                    bossInfo = ((int?)m["alive"] ?? 0) == 1 ? m : null;
                    break;
                case "melee":
                    meleeInfo = ((bool?)m["state"]?["active"] ?? false) ? (JObject)m["state"] : null;
                    break;
                case "party":
                    partyMembers = (JArray)m["members"];
                    break;
                case "pinvite":
                    inviteFrom = (string)m["from"];
                    inviteUntil = Time.time + 30f;
                    Toast($"👥 {inviteFrom} 邀请你组队 —— 按 Y 接受 / N 拒绝");
                    break;
                case "baoe":
                {
                    // 世界BOSS震地：红色冲击波 + 若我在范围附近则镜头震动
                    var at = new Vector3((float)m["x"], 0.2f, (float)m["z"]);
                    SpawnShockwave(at, (float?)m["r"] ?? 7f, new Color(1f, 0.2f, 0.27f));
                    if ((at - pos).sqrMagnitude < 14f * 14f) Shake(0.45f, 0.5f);
                    break;
                }
                case "maoe":
                {
                    // 精英怪范围震击：紫色冲击波
                    var at = new Vector3((float)m["x"], 0.2f, (float)m["z"]);
                    SpawnShockwave(at, (float?)m["r"] ?? 4.5f, new Color(0.69f, 0.31f, 1f));
                    if ((at - pos).sqrMagnitude < 9f * 9f) Shake(0.25f, 0.3f);
                    break;
                }
                case "bstorm":
                {
                    // 世界BOSS大范围魔法风暴：超大紫色冲击波 + 强震
                    var at = new Vector3((float)m["x"], 0.2f, (float)m["z"]);
                    float r = (float?)m["r"] ?? 16f;
                    SpawnShockwave(at, r, new Color(0.8f, 0.27f, 1f));
                    if ((at - pos).sqrMagnitude < r * r) Shake(0.6f, 0.7f);
                    break;
                }
                case "dimfx":
                {
                    var kind = (string)m["kind"];
                    Vector3 at = m["x"] != null ? new Vector3((float)m["x"], 0.2f, (float)m["z"]) : EntPos((string)m["id"]);
                    Color c = kind == "shield" ? new Color(0f, 0.66f, 1f)
                        : kind == "heal" ? new Color(0.18f, 0.8f, 0.44f)
                        : kind == "blink" ? new Color(0.91f, 0.27f, 0.58f)
                        : new Color(0.6f, 0.35f, 0.71f);
                    SpawnShockwave(at, kind == "field" ? ((float?)m["r"] ?? 6f) : 2.5f, c);
                    break;
                }
                case "rooted": rootedUntil = Time.time + ((float?)m["ms"] ?? 2000) / 1000f; Toast("🔮 你被禁锢了！"); break;
                case "feed": Feed((string)m["msg"]); break;
                case "chat": Feed($"💬 {(string)m["name"]}：{(string)m["msg"]}"); break;
                case "ach":
                    Toast($"{(string)m["icon"]} 成就解锁：【{(string)m["name"]}】");
                    Feed($"{(string)m["icon"]} 达成成就【{(string)m["name"]}】：{(string)m["desc"]}");
                    break;
                case "err": Toast("⚠ " + (string)m["msg"]); break;
            }
        }

        /* ================= 场景与实体 ================= */

        void EnterRoom(string roomId, JObject m)
        {
            curRoom = roomId;
            foreach (var e in players.Values) Destroy(e.go);
            foreach (var e in monsters.Values) Destroy(e.go);
            foreach (var e in pets.Values) Destroy(e.go);
            foreach (var p in projs.Values) Destroy(p.go);
            players.Clear(); monsters.Clear(); pets.Clear(); projs.Clear();
            BuildWorld(roomId == "war" ? Data.WarDim : Data.Dim(myDim));

            pos = new Vector3((float?)m["x"] ?? 0, 0, (float?)m["z"] ?? 0);
            meDead = false;
            if (meGo != null) Destroy(meGo);
            meGo = MakeHero(myCls, myDim);
            meGo.name = "Me";
            meDrv = meGo.GetComponent<DWAnimDriver>();

            if (m["players"] != null)
                foreach (JObject p in (JArray)m["players"]) AddPlayer(p);
        }

        /* 各次元 KayKit 场景道具（文件名，对应 Resources/DWProps/*.glb） */
        static readonly Dictionary<string, string[]> PropNames = new Dictionary<string, string[]>
        {
            { "tech",    new[] { "tech_basemodule_A", "tech_basemodule_B", "tech_containers_A", "tech_drill_structure", "tech_rocks_A", "tech_solarpanel" } },
            { "xiuxian", new[] { "xiuxian_column", "xiuxian_rock_single_A", "xiuxian_torch_lit", "xiuxian_tree_single_A", "xiuxian_trees_B_medium" } },
            { "cyber",   new[] { "cyber_building_A", "cyber_building_B", "cyber_building_D", "cyber_dumpster", "cyber_streetlight", "cyber_trafficlight_A" } },
            { "magic",   new[] { "magic_chest_gold", "magic_column", "magic_crates_stacked", "magic_pillar_decorated", "magic_rubble_large", "magic_torch_lit" } },
            { "hunter",  new[] { "hunter_lantern_standing", "hunter_rock_single_C", "hunter_tree_dead_medium", "hunter_tree_pine_orange_small", "hunter_tree_pine_yellow_small" } },
            { "war",     new[] { "war_fence_pillar_broken", "war_gravestone", "war_pillar", "war_rubble_half", "war_rubble_large", "war_torch_lit" } },
        };

        void BuildWorld(DimDef theme)
        {
            foreach (var o in worldObjs) Destroy(o);
            worldObjs.Clear();

            RenderSettings.fog = true;
            RenderSettings.fogMode = FogMode.Linear;
            RenderSettings.fogStartDistance = 35;
            RenderSettings.fogEndDistance = 150;
            RenderSettings.fogColor = theme.fog;
            RenderSettings.ambientLight = theme.ground * 1.6f;
            cam.clearFlags = CameraClearFlags.SolidColor;
            cam.backgroundColor = theme.fog;
            cam.farClipPlane = 300;

            var ground = GameObject.CreatePrimitive(PrimitiveType.Plane);
            float gscale = (Data.MapHalf * 2f + 40f) / 10f;   // Plane 原始 10×10，铺满整张地图
            ground.transform.localScale = new Vector3(gscale, 1, gscale);
            Tint(ground, theme.ground);
            worldObjs.Add(ground);

            var sun = new GameObject("Sun").AddComponent<Light>();
            sun.type = LightType.Directional;
            sun.intensity = 1.1f;
            sun.transform.rotation = Quaternion.Euler(50, -30, 0);
            worldObjs.Add(sun.gameObject);

            // 场景摆件：优先用 KayKit 真模型（按文件名精确加载），否则方块占位
            var rng = new System.Random(theme.id.GetHashCode());
            var themeProps = new List<GameObject>();
            string[] names;
            if (PropNames.TryGetValue(theme.id, out names))
                foreach (var n in names)
                {
                    var pf = Resources.Load<GameObject>("DWProps/" + n);
                    if (pf != null) themeProps.Add(pf);
                }

            int propCount = Mathf.RoundToInt(Data.MapHalf * 2.2f);   // 随地图变大而变密
            for (int i = 0; i < propCount; i++)
            {
                float a = (float)(rng.NextDouble() * Math.PI * 2);
                float r = 22 + (float)rng.NextDouble() * (Data.MapHalf - 28);
                var p2 = new Vector3(Mathf.Cos(a) * r, 0, Mathf.Sin(a) * r);
                if (themeProps.Count > 0)
                {
                    var src = themeProps[rng.Next(themeProps.Count)];
                    var o = Instantiate(src);
                    o.transform.position = p2;
                    o.transform.rotation = Quaternion.Euler(0, (float)(rng.NextDouble() * 360), 0);
                    float s = 1.6f + (float)rng.NextDouble() * 1.2f;   // KayKit 原始较小，放大
                    o.transform.localScale = Vector3.one * s;
                    worldObjs.Add(o);
                }
                else
                {
                    var o = GameObject.CreatePrimitive(rng.NextDouble() < 0.5 ? PrimitiveType.Cube : PrimitiveType.Cylinder);
                    float h = 1.5f + (float)rng.NextDouble() * 5f;
                    o.transform.position = new Vector3(p2.x, h / 2, p2.z);
                    o.transform.localScale = new Vector3(1.2f, h, 1.2f);
                    Tint(o, Color.Lerp(theme.ground * 1.8f, theme.accent, 0.12f));
                    worldObjs.Add(o);
                }
            }
        }

        static void Tint(GameObject go, Color c)
        {
            var r = go.GetComponent<Renderer>();
            if (r != null) r.material.color = c;
        }

        /* 把整个模型的材质颜色朝某色混合（用于怪物按次元染色） */
        static void TintHierarchy(GameObject go, Color c, float amount)
        {
            foreach (var r in go.GetComponentsInChildren<Renderer>(true))
            {
                var mats = r.materials;   // 实例化材质，不影响共享资源
                for (int i = 0; i < mats.Length; i++)
                    if (mats[i] != null && mats[i].HasProperty("_Color"))
                        mats[i].color = Color.Lerp(mats[i].color, c, amount);
                r.materials = mats;
            }
        }

        // 英雄模型池（向导生成于 Resources/DWHeroes），按名字排序保证各端一致
        GameObject[] heroPool;
        GameObject[] LoadSorted(string folder)
        {
            var arr = Resources.LoadAll<GameObject>(folder);
            System.Array.Sort(arr, (a, b) => string.CompareOrdinal(a.name, b.name));
            return arr;
        }
        static int ClassIdx(string id)
        {
            for (int i = 0; i < Data.Classes.Length; i++) if (Data.Classes[i].id == id) return i;
            return 0;
        }
        static int DimIdx(string id)
        {
            for (int i = 0; i < Data.Dims.Length; i++) if (Data.Dims[i].id == id) return i;
            return 0;
        }

        /* 英雄模型按「次元×职业」组合从角色池里确定（确定性，各端一致，用上所有模型）：
         *  1) 显式覆盖 DW/hero_{dim}_{cls} → 2) 角色池按组合取模 → 3) 占位小人 */
        GameObject MakeHero(string clsId, string dimId)
        {
            var prefab = Resources.Load<GameObject>("DW/hero_" + dimId + "_" + clsId)
                       ?? Resources.Load<GameObject>("DW/hero_" + clsId);
            if (prefab == null)
            {
                if (heroPool == null) heroPool = LoadSorted("DWHeroes");
                if (heroPool.Length > 0)
                {
                    int combo = ClassIdx(clsId) * Data.Dims.Length + DimIdx(dimId);
                    prefab = heroPool[combo % heroPool.Length];
                }
            }
            if (prefab == null)
                return MakeHumanoid(Data.Dim(dimId).accent, clsId == "tank" ? 1.12f : 1f);
            var root = new GameObject("Hero");
            var inst = Instantiate(prefab, root.transform);
            var b = CalcBounds(inst);
            float target = clsId == "tank" ? 2.0f : 1.85f;
            float scale = target / Mathf.Max(0.1f, b.size.y);
            inst.transform.localScale = Vector3.one * scale;
            b = CalcBounds(inst);
            inst.transform.localPosition = new Vector3(0, -b.min.y, 0);   // 脚踩地面
            root.AddComponent<DWAnimDriver>();
            AttachWeapon(inst, clsId);
            return root;
        }

        /* 按职业给人形模型的右手绑武器（金箍棒/剑），位置可后续微调 */
        void AttachWeapon(GameObject inst, string clsId)
        {
            var an = inst.GetComponentInChildren<Animator>();
            if (an == null || an.avatar == null || !an.avatar.isHuman) return;
            var hand = an.GetBoneTransform(HumanBodyBones.RightHand);
            if (hand == null) return;

            if (clsId == "assassin")          // 悟空 → 金箍棒
            {
                var staff = new GameObject("RuyiJinguBang");
                staff.transform.SetParent(hand, false);
                staff.transform.localPosition = new Vector3(0.02f, 0.02f, 0f);
                staff.transform.localRotation = Quaternion.Euler(0, 0, 90); // 横握成棍
                // 金色棍身
                var rod = GameObject.CreatePrimitive(PrimitiveType.Cylinder);
                rod.transform.SetParent(staff.transform, false);
                rod.transform.localScale = new Vector3(0.035f, 0.95f, 0.035f);
                var gold = new Color(0.95f, 0.78f, 0.2f);
                var rm = rod.GetComponent<Renderer>().material;
                rm.color = gold; rm.EnableKeyword("_EMISSION");
                rm.SetColor("_EmissionColor", gold * 0.35f);
                Destroy(rod.GetComponent<Collider>());
                // 两端红铜箍
                foreach (var yy in new[] { 0.95f, -0.95f })
                {
                    var cap = GameObject.CreatePrimitive(PrimitiveType.Cylinder);
                    cap.transform.SetParent(staff.transform, false);
                    cap.transform.localScale = new Vector3(0.05f, 0.06f, 0.05f);
                    cap.transform.localPosition = new Vector3(0, yy, 0);
                    Tint(cap, new Color(0.55f, 0.2f, 0.1f));
                    Destroy(cap.GetComponent<Collider>());
                }
            }
            else if (clsId == "warrior")      // 半血男 → 剑
            {
                var sword = GameObject.CreatePrimitive(PrimitiveType.Cube);
                sword.name = "Blade";
                sword.transform.SetParent(hand, false);
                sword.transform.localScale = new Vector3(0.05f, 0.9f, 0.012f);
                sword.transform.localPosition = new Vector3(0.02f, 0.45f, 0f);
                Tint(sword, new Color(0.8f, 0.85f, 0.9f));
                Destroy(sword.GetComponent<Collider>());
                var guard = GameObject.CreatePrimitive(PrimitiveType.Cube);
                guard.transform.SetParent(hand, false);
                guard.transform.localScale = new Vector3(0.18f, 0.04f, 0.04f);
                guard.transform.localPosition = new Vector3(0.02f, 0.04f, 0f);
                Tint(guard, new Color(0.5f, 0.4f, 0.15f));
                Destroy(guard.GetComponent<Collider>());
            }
        }

        static Bounds CalcBounds(GameObject go)
        {
            var rs = go.GetComponentsInChildren<Renderer>(true);
            if (rs.Length == 0) return new Bounds(go.transform.position, Vector3.one);
            var b = rs[0].bounds;
            foreach (var r in rs) b.Encapsulate(r.bounds);
            return b;
        }

        GameObject MakeHumanoid(Color c, float scale)
        {
            var root = new GameObject("Humanoid");
            var body = GameObject.CreatePrimitive(PrimitiveType.Capsule);
            body.transform.SetParent(root.transform, false);
            body.transform.localPosition = new Vector3(0, 1f, 0);
            Tint(body, c);
            var head = GameObject.CreatePrimitive(PrimitiveType.Sphere);
            head.transform.SetParent(root.transform, false);
            head.transform.localPosition = new Vector3(0, 2.05f, 0);
            head.transform.localScale = Vector3.one * 0.5f;
            Tint(head, Color.Lerp(c, Color.white, 0.4f));
            root.transform.localScale = Vector3.one * scale;
            return root;
        }

        TextMesh MakeLabel(GameObject parent, float height)
        {
            var go = new GameObject("Label");
            go.transform.SetParent(parent.transform, false);
            go.transform.localPosition = new Vector3(0, height, 0);
            // 黑色描边（背后4个偏移副本，子物体），文字在 UpdateLabel 同步
            foreach (var off in new[] { new Vector2(1, 0), new Vector2(-1, 0), new Vector2(0, 1), new Vector2(0, -1) })
            {
                var sgo = new GameObject("Outline");
                sgo.transform.SetParent(go.transform, false);
                sgo.transform.localPosition = new Vector3(off.x * 0.012f, off.y * 0.012f, 0.002f);
                var stm = sgo.AddComponent<TextMesh>();
                ConfigLabel(stm, sgo);
                stm.color = Color.black;
            }
            var tm = go.AddComponent<TextMesh>();
            ConfigLabel(tm, go);
            return tm;
        }

        void ConfigLabel(TextMesh tm, GameObject go)
        {
            tm.anchor = TextAnchor.MiddleCenter;
            tm.alignment = TextAlignment.Center;
            tm.characterSize = 0.11f;
            tm.fontSize = 56;
            tm.fontStyle = FontStyle.Bold;
            if (cjkFont != null)
            {
                tm.font = cjkFont;
                go.GetComponent<MeshRenderer>().material = cjkFont.material;
            }
        }

        void AddPlayer(JObject p)
        {
            var id = (string)p["id"];
            if (id == myId || players.ContainsKey(id)) return;
            var dim = (string)p["dim"];
            var e = new Ent
            {
                name = (string)p["name"], dim = dim, cls = (string)p["cls"] ?? "warrior",
                level = (int?)p["level"] ?? 1,
                hp = (int?)p["hp"] ?? 1, maxHp = (int?)p["maxHp"] ?? 1,
                target = new Vector3((float)p["x"], 0, (float)p["z"]),
                dead = (bool?)p["dead"] ?? false,
            };
            e.go = MakeHero(e.cls, dim);
            e.go.transform.position = e.target;
            e.label = MakeLabel(e.go, 2.6f);
            players[id] = e;
            UpdateLabel(e, dim == myDim ? "#7CFC9A" : "#ff7788");
        }

        void AddMonster(string id, float x, float z, string mstate, int hp, int maxHp, int tier, string name, int level = 1)
        {
            var e = new Ent { name = name, tier = tier, level = level, hp = hp, maxHp = maxHp, isMonster = true, target = new Vector3(x, 0, z) };
            e.go = MakeCreature(tier, id);
            e.go.transform.position = e.target;
            e.label = MakeLabel(e.go, 1.1f + tier * 0.45f);
            monsters[id] = e;
            e.dead = mstate == "dead";
            e.go.SetActive(!e.dead);
            UpdateLabel(e, "#ffaa33");
        }

        // 怪物模型池（向导生成于 Resources/DWMobs）
        GameObject[] mobPool;

        /* 怪物模型：tier≥5(世界BOSS)→小丑 DW/mon_boss；普通怪→怪物池按id稳定取；再退 KayKit；最后占位 */
        GameObject MakeCreature(int tier, string id)
        {
            GameObject prefab = null;
            if (tier >= 5) prefab = Resources.Load<GameObject>("DW/mon_boss");
            if (prefab == null)
            {
                if (mobPool == null) mobPool = LoadSorted("DWMobs");
                if (mobPool.Length > 0) prefab = mobPool[Mathf.Abs((id ?? "").GetHashCode()) % mobPool.Length];
            }
            if (prefab == null) prefab = Resources.Load<GameObject>("DWMon/mon_t" + Mathf.Clamp(tier, 1, 4));
            if (prefab != null)
            {
                var root = new GameObject("Monster");
                var inst = Instantiate(prefab, root.transform);
                var b = CalcBounds(inst);
                float target = 1.2f + tier * 0.45f;
                inst.transform.localScale = Vector3.one * (target / Mathf.Max(0.1f, b.size.y));
                b = CalcBounds(inst);
                inst.transform.localPosition = new Vector3(0, -b.min.y, 0);
                root.AddComponent<DWAnimDriver>();
                if (tier < 5) TintHierarchy(inst, Data.Dim(curRoom == "war" ? "war" : myDim).accent, 0.28f);  // 按次元染色，BOSS保持原色
                return root;
            }
            // 占位：身子+头+獠牙状，统一敌对橙红色，避免和地面同色糊成团
            var go = new GameObject("Monster");
            float s = 0.55f + tier * 0.28f;
            var enemy = Color.Lerp(new Color(0.55f, 0.12f, 0.10f), new Color(0.95f, 0.45f, 0.10f), (tier - 1) / 3f);
            var body = GameObject.CreatePrimitive(PrimitiveType.Capsule);
            body.transform.SetParent(go.transform, false);
            body.transform.localScale = new Vector3(s, s * 0.7f, s);
            body.transform.localPosition = new Vector3(0, s * 0.7f, 0);
            Tint(body, enemy);
            var head = GameObject.CreatePrimitive(PrimitiveType.Sphere);
            head.transform.SetParent(go.transform, false);
            head.transform.localScale = Vector3.one * s * 0.8f;
            head.transform.localPosition = new Vector3(0, s * 1.25f, s * 0.15f);
            Tint(head, Color.Lerp(enemy, Color.black, 0.25f));
            // 两只发光红眼，让怪物有"活物"感
            foreach (var sx in new[] { -1f, 1f })
            {
                var eye = GameObject.CreatePrimitive(PrimitiveType.Sphere);
                eye.transform.SetParent(go.transform, false);
                eye.transform.localScale = Vector3.one * s * 0.18f;
                eye.transform.localPosition = new Vector3(sx * s * 0.22f, s * 1.32f, s * 0.5f);
                var em = eye.GetComponent<Renderer>().material;
                em.color = new Color(1f, 0.85f, 0.2f);
                em.EnableKeyword("_EMISSION");
                em.SetColor("_EmissionColor", new Color(1f, 0.7f, 0.1f) * 1.5f);
            }
            return go;
        }

        void AddPet(string ownerId, int tier, float x, float z, int hp, int maxHp, string name)
        {
            var e = new Ent { name = "🐾" + name, tier = tier, hp = hp, maxHp = maxHp, isPet = true, target = new Vector3(x, 0, z) };
            e.go = new GameObject("Pet");
            var body = GameObject.CreatePrimitive(PrimitiveType.Sphere);
            body.transform.SetParent(e.go.transform, false);
            float s = 0.6f + tier * 0.25f;
            body.transform.localScale = Vector3.one * s;
            body.transform.localPosition = new Vector3(0, s * 0.5f, 0);
            Tint(body, Data.Hex("#7CFC9A"));
            e.go.transform.position = e.target;
            e.label = MakeLabel(e.go, s + 0.8f);
            pets[ownerId] = e;
            UpdateLabel(e, "#7CFC9A");
        }

        void UpdateLabel(Ent e, string colorHex)
        {
            if (e.label == null) return;
            Color c;
            ColorUtility.TryParseHtmlString(colorHex, out c);
            e.label.color = c;
            string title = e.isPet ? e.name : $"{e.name} Lv.{e.level}";
            e.label.text = $"{title}\n{e.hp}/{e.maxHp}";
            foreach (Transform ch in e.label.transform)   // 同步描边副本文字
            {
                var ot = ch.GetComponent<TextMesh>();
                if (ot != null) ot.text = e.label.text;
            }
        }

        void RemoveEnt(Dictionary<string, Ent> dict, string id)
        {
            Ent e;
            if (dict.TryGetValue(id, out e)) { Destroy(e.go); dict.Remove(id); }
        }

        void OnSnap(JObject m)
        {
            var seen = new HashSet<string>();
            foreach (JArray a in (JArray)m["ps"])
            {
                var id = (string)a[0];
                if (id == myId) continue;
                seen.Add(id);
                Ent e;
                if (!players.TryGetValue(id, out e)) continue; // 等 pjoin
                e.target = new Vector3((float)a[1], 0, (float)a[2]);
                e.tRy = (float)a[3];
                e.anim = (string)a[4];
                int hp = (int)a[5], max = (int)a[6], lvl = (int)a[7];
                e.dead = (int)a[8] == 1;
                if (e.hp != hp || e.level != lvl) { e.hp = hp; e.maxHp = max; e.level = lvl; UpdateLabel(e, e.dim == myDim ? "#7CFC9A" : "#ff7788"); }
            }
            foreach (var id in new List<string>(players.Keys)) if (!seen.Contains(id)) RemoveEnt(players, id);

            var seenM = new HashSet<string>();
            foreach (JArray a in (JArray)m["ms"])
            {
                var id = (string)a[0];
                seenM.Add(id);
                Ent e;
                if (!monsters.TryGetValue(id, out e))
                {
                    AddMonster(id, (float)a[1], (float)a[2], (string)a[4], (int)a[5], (int)a[6], (int)a[7], (string)a[8], a.Count > 9 ? (int)a[9] : 1);
                    continue;
                }
                e.target = new Vector3((float)a[1], 0, (float)a[2]);
                e.tRy = (float)a[3];
                bool deadNow = (string)a[4] == "dead";
                if (deadNow != e.dead) { e.dead = deadNow; e.go.SetActive(!deadNow); }
                int hp = (int)a[5];
                if (e.hp != hp) { e.hp = hp; UpdateLabel(e, "#ffaa33"); }
            }
            foreach (var id in new List<string>(monsters.Keys)) if (!seenM.Contains(id)) RemoveEnt(monsters, id);

            var seenPet = new HashSet<string>();
            if (m["pets"] != null)
                foreach (JArray a in (JArray)m["pets"])
                {
                    var oid = (string)a[0];
                    seenPet.Add(oid);
                    Ent e;
                    if (!pets.TryGetValue(oid, out e))
                    {
                        AddPet(oid, (int)a[1], (float)a[2], (float)a[3], (int)a[6], (int)a[7], (string)a[8]);
                        continue;
                    }
                    e.target = new Vector3((float)a[2], 0, (float)a[3]);
                    int hp = (int)a[6];
                    if (e.hp != hp) { e.hp = hp; UpdateLabel(e, "#7CFC9A"); }
                }
            foreach (var id in new List<string>(pets.Keys)) if (!seenPet.Contains(id)) RemoveEnt(pets, id);
        }

        void OnDmg(JObject m)
        {
            var kind = (string)m["kind"];
            var id = (string)m["id"];
            int amt = (int)m["amt"], hp = (int)m["hp"];
            if (kind == "m")
            {
                Ent e;
                if (monsters.TryGetValue(id, out e))
                {
                    e.hp = hp; UpdateLabel(e, "#ffaa33");
                    FloatText(amt.ToString(), e.target, (string)m["by"] == myId ? Color.yellow : Color.white);
                }
            }
            else if (kind == "pet")
            {
                Ent e;
                if (pets.TryGetValue(id, out e)) { e.hp = hp; UpdateLabel(e, "#7CFC9A"); }
            }
            else
            {
                if (id == myId) { FloatText("-" + amt, pos, Color.red); Shake(0.2f, 0.18f); }
                else
                {
                    Ent e;
                    if (players.TryGetValue(id, out e))
                    {
                        e.hp = hp; UpdateLabel(e, e.dim == myDim ? "#7CFC9A" : "#ff7788");
                        FloatText(amt.ToString(), e.target, Color.white);
                    }
                }
            }
        }

        void SpawnProj(string id, float x, float z, float dx, float dz, float speed, Color c)
        {
            var go = GameObject.CreatePrimitive(PrimitiveType.Sphere);
            go.transform.localScale = Vector3.one * 0.55f;
            go.transform.position = new Vector3(x, 1.1f, z);
            Tint(go, c);
            var l = go.AddComponent<Light>();
            l.color = c; l.range = 6; l.intensity = 2.2f;
            projs[id] = new Proj { go = go, dir = new Vector3(dx, 0, dz), speed = speed, dieAt = Time.time + 3f };
        }

        void FloatText(string txt, Vector3 at, Color c)
        {
            var go = new GameObject("dmg");
            go.transform.position = at + new Vector3(UnityEngine.Random.Range(-0.4f, 0.4f), 2.4f, 0);
            var tm = go.AddComponent<TextMesh>();
            tm.text = txt;
            tm.color = c;
            tm.anchor = TextAnchor.MiddleCenter;
            tm.characterSize = 0.12f;
            tm.fontSize = 46;
            if (cjkFont != null) { tm.font = cjkFont; go.GetComponent<MeshRenderer>().material = cjkFont.material; }
            go.AddComponent<FloatUp>();
        }

        /* ================= 操控/移动/相机 ================= */

        int MyLevel => you != null ? (int?)you["level"] ?? 1 : 1;
        int MySkLvl(string k) => you != null && you["sk"] != null ? (int?)you["sk"][k] ?? 1 : 1;
        int MySkPts => you != null ? (int?)you["skPts"] ?? 0 : 0;
        float MySpeed => you != null && you["spd"] != null ? (float)you["spd"] : Data.Cls(myCls).speed;

        // 触屏：左半屏虚拟摇杆，右半屏拖动转视角
        protected int moveTouchId = -1;
        int lookTouchId = -1;
        protected Vector2 moveTouchStart, moveTouchVec;

        void UpdateTouch()
        {
            for (int i = 0; i < Input.touchCount; i++)
            {
                var t = Input.GetTouch(i);
                if (t.phase == TouchPhase.Began)
                {
                    var guiPos = new Vector2(t.position.x / uiScale, (Screen.height - t.position.y) / uiScale);
                    bool overGui = false;
                    foreach (var r in guiRects) if (r.Contains(guiPos)) { overGui = true; break; }
                    if (overGui) continue;
                    if (t.position.x < Screen.width / 2f && moveTouchId < 0)
                    { moveTouchId = t.fingerId; moveTouchStart = t.position; moveTouchVec = Vector2.zero; }
                    else if (lookTouchId < 0) lookTouchId = t.fingerId;
                }
                else if (t.fingerId == moveTouchId)
                {
                    if (t.phase == TouchPhase.Ended || t.phase == TouchPhase.Canceled) { moveTouchId = -1; moveTouchVec = Vector2.zero; }
                    else moveTouchVec = Vector2.ClampMagnitude((t.position - moveTouchStart) / 70f, 1f);
                }
                else if (t.fingerId == lookTouchId)
                {
                    if (t.phase == TouchPhase.Ended || t.phase == TouchPhase.Canceled) lookTouchId = -1;
                    else if (t.phase == TouchPhase.Moved)
                    {
                        camYaw -= t.deltaPosition.x * 0.006f;
                        camPitch = Mathf.Clamp(camPitch + t.deltaPosition.y * 0.005f, 0.12f, 1.25f);
                    }
                }
            }
        }

        void UpdateInput()
        {
            if (chatOpen) return;   // 聊天时键盘归输入框
            if (Input.GetKeyDown(KeyCode.T)) { chatOpen = true; return; }
            if (inviteFrom != null && Time.time < inviteUntil)
            {
                if (Input.GetKeyDown(KeyCode.Y)) { Send(new { t = "party", op = "accept" }); inviteFrom = null; }
                else if (Input.GetKeyDown(KeyCode.N)) { Send(new { t = "party", op = "decline" }); inviteFrom = null; }
            }
            UpdateTouch();
            bool touching = Input.touchCount > 0;  // 触屏时屏蔽模拟出来的鼠标事件
            if (!touching && Input.GetMouseButton(1))
            {
                camYaw -= Input.GetAxis("Mouse X") * 0.05f;
                camPitch = Mathf.Clamp(camPitch + Input.GetAxis("Mouse Y") * 0.04f, 0.12f, 1.25f);
            }
            camDist = Mathf.Clamp(camDist - Input.GetAxis("Mouse ScrollWheel") * 6f, 6f, 20f);

            if (meDead)
            {
                if (Time.time - deadAt > 4f && Input.GetKeyDown(KeyCode.Space)) Send(new { t = "respawn" });
                return;
            }
            if (!touching && Input.GetMouseButtonDown(0) && !MouseOverGui()) Cast("basic");
            if (Input.GetKeyDown(KeyCode.Q)) Cast("q");
            if (Input.GetKeyDown(KeyCode.E)) Cast("e");
            if (Input.GetKeyDown(KeyCode.R)) Cast("r");
            if (Input.GetKeyDown(KeyCode.B)) panelOpen = !panelOpen;
            if (Input.GetKeyDown(KeyCode.F) && Time.time > captureReadyAt)
            {
                captureReadyAt = Time.time + (dimSkillCd > 0 ? dimSkillCd : 3f);
                Send(new { t = "dimskill" });   // 各次元专属技能（猎人=捕捉）
            }
            if (Input.GetKeyDown(KeyCode.Space) && Time.time > dodgeReadyAt)
            {
                dodgeReadyAt = Time.time + 1.2f;
                var mv = MoveVec();
                burstDir = mv.sqrMagnitude > 0.01f ? mv.normalized : new Vector3(Mathf.Sin(ry), 0, Mathf.Cos(ry));
                burstSpeed = 21f;
                burstUntil = Time.time + 0.24f;
            }
        }

        Vector3 EntPos(string id)
        {
            if (id == myId) return pos;
            Ent e;
            if (players.TryGetValue(id, out e) && e.go != null) return e.go.transform.position;
            return pos;
        }

        Vector3 MoveVec()
        {
            if (Time.time < rootedUntil) return Vector3.zero;   // 被魔法禁锢
            float fx = moveTouchVec.x, fz = moveTouchVec.y;
            if (Input.GetKey(KeyCode.W)) fz += 1;
            if (Input.GetKey(KeyCode.S)) fz -= 1;
            if (Input.GetKey(KeyCode.A)) fx -= 1;
            if (Input.GetKey(KeyCode.D)) fx += 1;
            if (Mathf.Abs(fx) < 0.12f && Mathf.Abs(fz) < 0.12f) return Vector3.zero;
            var v = Vector3.ClampMagnitude(new Vector3(fx, 0, fz), 1f);
            float s = Mathf.Sin(camYaw), c = Mathf.Cos(camYaw);
            // 相机相对移动：forward=(-sin,-cos)、right=(-cos,sin)，A/D 之前算反了
            return new Vector3(-v.x * c - v.z * s, 0, v.x * s - v.z * c);
        }

        void UpdateMove()
        {
            if (meDead) { return; }
            Vector3 vel;
            float speed;
            if (Time.time < burstUntil) { vel = burstDir; speed = burstSpeed; }
            else { vel = MoveVec(); speed = MySpeed; }
            bool moving = vel.sqrMagnitude > 0.01f;
            if (moving)
            {
                pos += vel * speed * Time.deltaTime;
                pos.x = Mathf.Clamp(pos.x, -Data.MapHalf, Data.MapHalf);
                pos.z = Mathf.Clamp(pos.z, -Data.MapHalf, Data.MapHalf);
                ry = Mathf.Atan2(vel.x, vel.z);
            }
            meGo.transform.position = pos;
            meGo.transform.rotation = Quaternion.Euler(0, ry * Mathf.Rad2Deg, 0);
            if (meDrv != null) meDrv.SetBase(moving ? "Run" : "Idle");

            if (Time.time - lastMvSent > 0.066f)
            {
                lastMvSent = Time.time;
                Send(new { t = "mv", x = Math.Round(pos.x, 2), z = Math.Round(pos.z, 2), ry = Math.Round(ry, 2), anim = moving ? "run" : "idle" });
            }
        }

        void Cast(string key)
        {
            var def = Data.Cls(myCls).Skill(key);
            float ready;
            readyAt.TryGetValue(key, out ready);
            if (Time.time < ready) return;
            if (def.minLvl > 0 && MyLevel < def.minLvl) { Toast($"⚠ 【{def.name}】需要 Lv.{def.minLvl} 解锁"); return; }
            readyAt[key] = Time.time + def.cdMs / 1000f;

            // 自动瞄准最近敌人
            float dx = Mathf.Sin(ry), dz = Mathf.Cos(ry);
            float best = def.kind == "proj" ? 26f * 26f : 9f * 9f;
            Vector3 aim = Vector3.zero;
            bool found = false;
            foreach (var e in monsters.Values)
            {
                if (e.dead) continue;
                float d = (e.target - pos).sqrMagnitude;
                if (d < best) { best = d; aim = e.target; found = true; }
            }
            if (curRoom == "war")
                foreach (var e in players.Values)
                {
                    if (e.dead || e.dim == myDim) continue;
                    float d = (e.target - pos).sqrMagnitude;
                    if (d < best) { best = d; aim = e.target; found = true; }
                }
            if (found)
            {
                var v = (aim - pos).normalized;
                dx = v.x; dz = v.z;
                ry = Mathf.Atan2(dx, dz);
            }
            if (def.kind == "dashmelee")
            {
                burstDir = new Vector3(dx, 0, dz);
                burstSpeed = 25f;
                burstUntil = Time.time + 0.18f;
            }
            if (meDrv != null) meDrv.PlayOnce(key == "basic" ? "Attack1" : "Skill", 0.6f);
            Send(new { t = "cast", k = key, dx = Math.Round(dx, 3), dz = Math.Round(dz, 3) });
        }

        void UpdateEntities()
        {
            float k = 1f - Mathf.Exp(-12f * Time.deltaTime);   // 平滑插值系数
            foreach (var e in players.Values) StepEnt(e, k);
            foreach (var e in monsters.Values) StepEnt(e, k);
            foreach (var e in pets.Values) StepEnt(e, k);

            var toRemove = new List<string>();
            foreach (var kv in projs)
            {
                kv.Value.go.transform.position += kv.Value.dir * kv.Value.speed * Time.deltaTime;
                if (Time.time > kv.Value.dieAt) { Destroy(kv.Value.go); toRemove.Add(kv.Key); }
            }
            foreach (var id in toRemove) projs.Remove(id);
        }

        void StepEnt(Ent e, float k)
        {
            if (e.go == null || !e.go.activeSelf) return;
            e.go.transform.position = Vector3.Lerp(e.go.transform.position, e.target, k);
            if (!e.isMonster && !e.isPet)
            {
                var drv = e.go.GetComponent<DWAnimDriver>();
                if (e.dead)
                {
                    // 有死亡动画就播动画，否则占位小人倒地
                    if (drv == null || !drv.SetBase("Death"))
                        e.go.transform.rotation = Quaternion.Euler(85, e.tRy * Mathf.Rad2Deg, 0);
                }
                else
                {
                    if (drv != null) drv.SetBase(e.anim == "run" ? "Run" : "Idle");
                    e.go.transform.rotation = Quaternion.Slerp(e.go.transform.rotation, Quaternion.Euler(0, e.tRy * Mathf.Rad2Deg, 0), k);
                }
            }
        }

        void Shake(float amp, float dur)
        {
            shakeAmp = Mathf.Max(shakeAmp, amp);
            shakeUntil = Mathf.Max(shakeUntil, Time.time + dur);
        }

        void SpawnShockwave(Vector3 at, float radius, Color c)
        {
            var go = GameObject.CreatePrimitive(PrimitiveType.Sphere);
            go.transform.position = at;
            Tint(go, c);
            var l = go.AddComponent<Light>();
            l.color = c; l.range = radius * 2.2f; l.intensity = 4f;
            var fx = go.AddComponent<Shockwave>();
            fx.radius = radius;
        }

        void UpdateCamera()
        {
            float cx = pos.x + Mathf.Sin(camYaw) * camDist * Mathf.Cos(camPitch);
            float cz = pos.z + Mathf.Cos(camYaw) * camDist * Mathf.Cos(camPitch);
            float cy = 1.5f + Mathf.Sin(camPitch) * camDist;
            cam.transform.position = Vector3.Lerp(cam.transform.position, new Vector3(cx, cy, cz), 0.25f);
            cam.transform.LookAt(new Vector3(pos.x, 1.6f, pos.z));
            if (Time.time < shakeUntil)
            {
                float k = shakeAmp * (shakeUntil - Time.time);
                cam.transform.position += new Vector3(
                    UnityEngine.Random.Range(-k, k), UnityEngine.Random.Range(-k, k), UnityEngine.Random.Range(-k, k));
            }
            else shakeAmp = 0;
        }

        void LateUpdate()
        {
            if (cam == null) return;
            // 名牌面向相机
            foreach (var e in players.Values) Billboard(e);
            foreach (var e in monsters.Values) Billboard(e);
            foreach (var e in pets.Values) Billboard(e);
        }

        void Billboard(Ent e)
        {
            if (e.label != null && e.go.activeSelf)
                e.label.transform.rotation = cam.transform.rotation;
        }

        /* ================= 提示信息 ================= */

        void Toast(string msg) { toastMsg = msg; toastUntil = Time.time + 3f; }
        void Feed(string msg)
        {
            feed.Insert(0, msg);
            feedAt.Insert(0, Time.time);
            while (feed.Count > 6) { feed.RemoveAt(feed.Count - 1); feedAt.RemoveAt(feedAt.Count - 1); }
        }
    }

    /* 骨骼动画驱动：状态不存在时静默跳过（保证任何模型都不报错） */
    public class DWAnimDriver : MonoBehaviour
    {
        Animator an;
        string baseState = "Idle";
        string applied = "";
        float oneUntil;

        void Awake() { an = GetComponentInChildren<Animator>(); }

        bool Has(string s) => an != null && an.runtimeAnimatorController != null
            && an.HasState(0, Animator.StringToHash(s));

        public bool SetBase(string s)
        {
            baseState = s;
            if (Time.time < oneUntil) return Has(s);
            return Apply(s, 0.15f);
        }

        public void PlayOnce(string s, float dur)
        {
            if (!Has(s)) return;
            an.CrossFadeInFixedTime(Animator.StringToHash(s), 0.05f, 0, 0f);
            applied = s;
            oneUntil = Time.time + dur;
        }

        bool Apply(string s, float fade)
        {
            if (!Has(s)) return false;
            if (applied == s) return true;
            an.CrossFade(Animator.StringToHash(s), fade);
            applied = s;
            return true;
        }

        void Update()
        {
            if (oneUntil > 0 && Time.time >= oneUntil) { oneUntil = 0; Apply(baseState, 0.15f); }
        }
    }

    public class Shockwave : MonoBehaviour
    {
        public float radius = 7f;
        float born;
        Light l;
        void Start() { born = Time.time; l = GetComponent<Light>(); }
        void Update()
        {
            float k = (Time.time - born) / 0.5f;
            if (k >= 1f) { Destroy(gameObject); return; }
            float s = radius * 2f * k;
            transform.localScale = new Vector3(s, 0.4f, s);
            if (l != null) l.intensity = 4f * (1f - k);
        }
    }

    public class FloatUp : MonoBehaviour
    {
        float born;
        void Start() { born = Time.time; }
        void Update()
        {
            transform.position += Vector3.up * 1.6f * Time.deltaTime;
            if (Camera.main != null) transform.rotation = Camera.main.transform.rotation;
            if (Time.time - born > 1.1f) Destroy(gameObject);
        }
    }
}
