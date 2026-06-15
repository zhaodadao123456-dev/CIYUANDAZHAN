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
using UnityEngine.UI;

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
        public const string DEFAULT_SERVER = "119.45.129.74";   // ★ 腾讯云服务器公网IP（玩家无需填写）
        string serverIp = DEFAULT_SERVER;
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
            public Vector3 target;
            public float tRy;
            public int hp, maxHp, level, tier;
            public string name, dim, cls, anim = "idle";
            public bool dead, isMonster, isPet;
            // UGUI 头顶名牌（屏幕空间，逐帧由世界坐标投影定位）
            public GameObject plate;
            public RectTransform plateRt;
            public Image plateFill;
            public Text plateName;
            public float plateH;
            public int plateLvl = -1;
        }
        readonly Dictionary<string, Ent> players = new Dictionary<string, Ent>();
        readonly Dictionary<string, Ent> monsters = new Dictionary<string, Ent>();
        readonly Dictionary<string, Ent> pets = new Dictionary<string, Ent>();

        class Proj { public GameObject go; public Vector3 dir; public float speed, dieAt; }
        readonly Dictionary<string, Proj> projs = new Dictionary<string, Proj>();

        // 相机
        float camYaw, camPitch = 0.78f, camDist = 9f;   // 更俯视、更近

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
            // 固定横屏
            Screen.orientation = ScreenOrientation.AutoRotation;
            Screen.autorotateToLandscapeLeft = true;
            Screen.autorotateToLandscapeRight = true;
            Screen.autorotateToPortrait = false;
            Screen.autorotateToPortraitUpsideDown = false;
            Screen.orientation = ScreenOrientation.LandscapeLeft;
            DWAudio.Music("bgm_menu");   // 登录界面背景音乐
            serverIp = DEFAULT_SERVER;   // 写死服务器，玩家不用填
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

            // 清运行时生成的图标/特效/贴图缓存：编辑器关闭 Domain Reload 时防止引用到上次已销毁的对象
            _kindIcons.Clear(); _slotIcons.Clear(); _pngIcons.Clear(); _fxCache.Clear(); _fxPools.Clear(); _fxBroken.Clear();
            _groundTex = _ringTex = _dotTex = _slashTex = null;
            _sparkMat = _trailMat = null;

            // 已有存档名字 → 用上次的名字/次元/职业自动登录，跳过填写界面（连不上才回登录界面）
            if (!string.IsNullOrEmpty(playerName)) Join();
        }

        /* ================= 连接与消息 ================= */

        // 退出当前对局，断开连接并清场，回到次元选择界面
        void ExitToMenu()
        {
            CancelInvoke();
            try { net?.Close(); } catch (Exception) { }
            net = null; joinSent = false;
            foreach (var e in players.Values) { DestroyPlate(e); if (e.go) Destroy(e.go); }
            foreach (var e in monsters.Values) { DestroyPlate(e); if (e.go) Destroy(e.go); }
            foreach (var e in pets.Values) { DestroyPlate(e); if (e.go) Destroy(e.go); }
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
            if (Input.GetKeyDown(KeyCode.M)) Toast(DWAudio.ToggleMute() ? "已静音" : "已开启声音");
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
            if (!hudBuilt) BuildHud();
            RefreshHud();
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
                    var pdim = (string)m["dim"];
                    var color = pdim == "mon" ? new Color(1f, 0.27f, 0.27f) : Data.Dim(pdim).accent;
                    SpawnProj((string)m["id"], (float)m["x"], (float)m["z"],
                        (float)m["dx"], (float)m["dz"], (float)m["speed"], color, pdim);
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
                        DWAudio.Sfx("levelup", 0.8f);
                    }
                    break;
                case "cast":
                {
                    Ent e;
                    if (players.TryGetValue((string)m["id"], out e))
                    {
                        e.tRy = Mathf.Atan2((float)m["dx"], (float)m["dz"]);
                        var drv = e.go != null ? e.go.GetComponent<DWAnimDriver>() : null;
                        if (drv != null && !drv.PlayOnce(SkillAnim((string)m["k"]), 0.6f)) drv.PlayOnce("Attack1", 0.6f);
                        var kk = (string)m["kk"];
                        DWAudio.SfxAt(kk == "proj" ? "laser" : (kk == "aoe" ? "explosion" : "swing"), e.target, pos, 0.6f);
                    }
                    break;
                }
                case "war":
                    if (m["state"] != null) warInfo = (JObject)m["state"];
                    break;
                case "boss":
                    bossInfo = ((int?)m["alive"] ?? 0) == 1 ? m : null;
                    if (bossInfo != null) DWAudio.Sfx("warhorn", 0.7f);
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
                    Toast($"{inviteFrom} 邀请你组队 —— 按 Y 接受 / N 拒绝");
                    break;
                case "baoe":
                {
                    // 世界BOSS震地：红色冲击波 + 若我在范围附近则镜头震动
                    var at = new Vector3((float)m["x"], 0.2f, (float)m["z"]);
                    SpawnShockwave(at, (float?)m["r"] ?? 7f, new Color(1f, 0.2f, 0.27f), "aoe");
                    DWAudio.SfxAt("explosion", at, pos, 0.9f);
                    if ((at - pos).sqrMagnitude < 14f * 14f) Shake(0.45f, 0.5f);
                    break;
                }
                case "maoe":
                {
                    // 精英怪范围震击：紫色冲击波
                    var at = new Vector3((float)m["x"], 0.2f, (float)m["z"]);
                    SpawnShockwave(at, (float?)m["r"] ?? 4.5f, new Color(0.69f, 0.31f, 1f), "lightning");
                    DWAudio.SfxAt("explosion", at, pos, 0.6f);
                    if ((at - pos).sqrMagnitude < 9f * 9f) Shake(0.25f, 0.3f);
                    break;
                }
                case "bstorm":
                {
                    // 世界BOSS大范围魔法风暴：超大紫色冲击波 + 强震
                    var at = new Vector3((float)m["x"], 0.2f, (float)m["z"]);
                    float r = (float?)m["r"] ?? 16f;
                    SpawnShockwave(at, r, new Color(0.8f, 0.27f, 1f), "storm");
                    DWAudio.SfxAt("explosion", at, pos, 1f);
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
                    string dfx = kind == "shield" ? "shield" : kind == "heal" ? "heal" : "circle";
                    SpawnShockwave(at, kind == "field" || kind == "emp" ? ((float?)m["r"] ?? 6f) : 2.5f, c, dfx);
                    DWAudio.SfxAt(kind == "blink" ? "dodge" : kind == "heal" ? "coin" : "explosion", at, pos, 0.6f);
                    break;
                }
                case "rooted": rootedUntil = Time.time + ((float?)m["ms"] ?? 2000) / 1000f; Toast("你被禁锢了！"); break;
                case "feed": Feed((string)m["msg"]); break;
                case "chat": Feed($"{(string)m["name"]}：{(string)m["msg"]}"); break;
                case "ach":
                    Toast($"{(string)m["icon"]} 成就解锁：【{(string)m["name"]}】");
                    Feed($"{(string)m["icon"]} 达成成就【{(string)m["name"]}】：{(string)m["desc"]}");
                    DWAudio.Sfx("coin", 0.7f);
                    break;
                case "err": Toast((string)m["msg"]); break;
            }
        }

        /* ================= 场景与实体 ================= */

        // 障碍物（与服务器一致）：x,z,r,t
        readonly List<Vector4> obstacles = new List<Vector4>();

        void EnterRoom(string roomId, JObject m)
        {
            curRoom = roomId;
            foreach (var e in players.Values) { DestroyPlate(e); Destroy(e.go); }
            foreach (var e in monsters.Values) { DestroyPlate(e); Destroy(e.go); }
            foreach (var e in pets.Values) { DestroyPlate(e); Destroy(e.go); }
            foreach (var p in projs.Values) Destroy(p.go);
            players.Clear(); monsters.Clear(); pets.Clear(); projs.Clear();
            obstacles.Clear();
            if (m["obstacles"] != null)
                foreach (JObject o in (JArray)m["obstacles"])
                    obstacles.Add(new Vector4((float)o["x"], (float)o["z"], (float)o["r"], (int?)o["t"] ?? 0));
            BuildWorld(roomId == "war" ? Data.WarDim : Data.Dim(myDim));
            DWAudio.Music(roomId == "war" || roomId == "melee" ? "bgm_war" : "bgm_world");

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
            RenderSettings.fogStartDistance = 50;
            RenderSettings.fogEndDistance = 240;
            RenderSettings.fogColor = theme.fog;
            // 每个次元一张渐变天空盒（更干净的天蓝 + 一点次元色），地平线提亮
            var sky = new Material(Shader.Find("Skybox/Procedural"));
            sky.SetColor("_SkyTint", Color.Lerp(new Color(0.45f, 0.62f, 0.92f), theme.accent, 0.20f));
            sky.SetColor("_GroundColor", Color.Lerp(theme.ground, new Color(0.62f, 0.64f, 0.7f), 0.45f));
            sky.SetFloat("_AtmosphereThickness", 0.85f);
            sky.SetFloat("_Exposure", 1.2f);
            sky.SetFloat("_SunSize", 0.045f);
            RenderSettings.skybox = sky;
            RenderSettings.ambientMode = UnityEngine.Rendering.AmbientMode.Flat;
            RenderSettings.ambientLight = Color.Lerp(theme.ground, new Color(0.6f, 0.62f, 0.68f), 0.6f);
            cam.clearFlags = CameraClearFlags.Skybox;
            cam.backgroundColor = theme.fog;
            cam.farClipPlane = 400;

            var ground = GameObject.CreatePrimitive(PrimitiveType.Plane);
            float gscale = (Data.MapHalf * 2f + 40f) / 10f;   // Plane 原始 10×10，铺满整张地图
            ground.transform.localScale = new Vector3(gscale, 1, gscale);
            Matte(ground, Color.Lerp(theme.ground, new Color(0.5f, 0.5f, 0.52f), 0.33f));   // 提亮地面，别太暗沉
            var gmat = ground.GetComponent<Renderer>().material;   // 叠程序化纹理（柔和斑块+细格），不再是纯色大平面
            gmat.mainTexture = GroundTex();
            float tiles = (10f * gscale) / 5f;                     // 每 ~5 米一格
            gmat.mainTextureScale = new Vector2(tiles, tiles);
            worldObjs.Add(ground);

            var sun = new GameObject("Sun").AddComponent<Light>();
            sun.type = LightType.Directional;
            sun.intensity = 0.85f;
            sun.color = new Color(1f, 0.97f, 0.9f);
            sun.transform.rotation = Quaternion.Euler(52, -30, 0);
            worldObjs.Add(sun.gameObject);

            // 场景摆件：优先用你买的场景模型(DWScene，如黑暗地牢)，其次 KayKit，最后方块占位
            var rng = new System.Random(theme.id.GetHashCode());
            var themeProps = new List<GameObject>();
            var userScene = Resources.LoadAll<GameObject>("DWScene");
            if (userScene.Length > 0)
            {
                themeProps.AddRange(userScene);
            }
            else
            {
                string[] names;
                if (PropNames.TryGetValue(theme.id, out names))
                    foreach (var n in names)
                    {
                        var pf = Resources.Load<GameObject>("DWProps/" + n);
                        if (pf != null) themeProps.Add(pf);
                    }
            }

            // 障碍物即可见场景：每个服务器障碍处放一棵树/一栋建筑（看得见=走不过去）
            if (obstacles.Count > 0)
            {
                for (int i = 0; i < obstacles.Count; i++)
                {
                    var ob = obstacles[i];
                    PlaceProp(themeProps, theme, new Vector3(ob.x, 0, ob.y), ob.z * 1.7f, i, rng);
                }
            }
            else   // 战场/混战等无障碍房间：随机点缀
            {
                int propCount = Mathf.RoundToInt(Data.MapHalf * 1.2f);
                for (int i = 0; i < propCount; i++)
                {
                    float a = (float)(rng.NextDouble() * Math.PI * 2);
                    float r = 22 + (float)rng.NextDouble() * (Data.MapHalf - 28);
                    PlaceProp(themeProps, theme, new Vector3(Mathf.Cos(a) * r, 0, Mathf.Sin(a) * r), 1.6f + (float)rng.NextDouble() * 1.2f, i, rng);
                }
            }

            // 额外装饰散布：让购买的自然包(Pure Poly 等)铺满地图，不只在障碍点（纯视觉、不挡路）
            if (themeProps.Count > 0 && obstacles.Count > 0)
            {
                int deco = 110;
                for (int i = 0; i < deco; i++)
                {
                    float a = (float)(rng.NextDouble() * Math.PI * 2);
                    float r = 16 + (float)rng.NextDouble() * (Data.MapHalf - 18);
                    PlaceProp(themeProps, theme, new Vector3(Mathf.Cos(a) * r, 0, Mathf.Sin(a) * r), 1.0f + (float)rng.NextDouble() * 1.1f, i + 9000, rng);
                }
            }
        }

        void PlaceProp(List<GameObject> themeProps, DimDef theme, Vector3 at, float scale, int idx, System.Random rng)
        {
            if (themeProps.Count > 0)
            {
                var src = themeProps[idx % themeProps.Count];
                var o = Instantiate(src);
                o.transform.position = at;
                o.transform.rotation = Quaternion.Euler(0, (float)(rng.NextDouble() * 360), 0);
                o.transform.localScale = Vector3.one * Mathf.Max(1.4f, scale);
                FixPinkMaterials(o, Color.Lerp(theme.ground * 2f, theme.accent, 0.25f));   // 换掉变粉(不兼容shader)的材质
                worldObjs.Add(o);
            }
            else
            {
                var o = GameObject.CreatePrimitive(PrimitiveType.Cylinder);
                float h = Mathf.Max(2f, scale * 1.6f);
                o.transform.position = new Vector3(at.x, h / 2, at.z);
                o.transform.localScale = new Vector3(scale, h, scale);
                Tint(o, Color.Lerp(theme.ground * 1.8f, theme.accent, 0.12f));
                worldObjs.Add(o);
            }
        }

        /* 本地碰撞：把坐标推出所有障碍圆（与服务器一致，避免回弹） */
        Vector3 ResolveObstacles(Vector3 p, float rad)
        {
            for (int k = 0; k < obstacles.Count; k++)
            {
                var o = obstacles[k];
                float dx = p.x - o.x, dz = p.z - o.y, min = o.z + rad;
                float d2 = dx * dx + dz * dz;
                if (d2 < min * min)
                {
                    float d = Mathf.Sqrt(d2); if (d < 0.001f) d = 0.001f;
                    p.x = o.x + dx / d * min; p.z = o.y + dz / d * min;
                }
            }
            return p;
        }

        static void Tint(GameObject go, Color c)
        {
            var r = go.GetComponent<Renderer>();
            if (r != null) r.material.color = c;
        }

        /* 哑光：去掉高光/金属感，避免地面中央出现刺眼白斑 */
        // 把用了「不兼容/缺失 shader」(会渲染成洋红) 的材质换成普通 Standard 材质，避免场景道具变粉
        static Material _pinkFixMat;
        static void FixPinkMaterials(GameObject go, Color tint)
        {
            foreach (var r in go.GetComponentsInChildren<Renderer>(true))
            {
                var mats = r.sharedMaterials;
                bool bad = false;
                foreach (var m in mats)
                {
                    var sh = m != null ? m.shader : null;
                    if (sh == null || !sh.isSupported || sh.name == "Hidden/InternalErrorShader") { bad = true; break; }
                }
                if (!bad) continue;
                if (_pinkFixMat == null) { _pinkFixMat = new Material(Shader.Find("Standard")); }
                var fix = new Material(_pinkFixMat) { color = tint };
                var arr = new Material[mats.Length];
                for (int i = 0; i < arr.Length; i++) arr[i] = fix;
                r.sharedMaterials = arr;
            }
        }

        static void Matte(GameObject go, Color c)
        {
            var r = go.GetComponent<Renderer>();
            if (r == null) return;
            var m = r.material;
            m.color = c;
            if (m.HasProperty("_Glossiness")) m.SetFloat("_Glossiness", 0f);
            if (m.HasProperty("_Smoothness")) m.SetFloat("_Smoothness", 0f);
            if (m.HasProperty("_Metallic")) m.SetFloat("_Metallic", 0f);
            if (m.HasProperty("_SpecularHighlights")) m.SetFloat("_SpecularHighlights", 0f);
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
         *  1) DW/hero_{dim}_{cls} → 2) DW/hero_{dim}（次元专属，向导依购买包分配）
         *  → 3) DW/hero_{cls} → 4) 角色池按组合取模 → 5) 占位小人 */
        GameObject MakeHero(string clsId, string dimId)
        {
            var prefab = Resources.Load<GameObject>("DW/hero_" + dimId + "_" + clsId)
                       ?? Resources.Load<GameObject>("DW/hero_" + dimId)
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
            float target = clsId == "tank" ? 2.7f : 2.4f;   // 放大英雄
            float scale = target / Mathf.Max(0.1f, b.size.y);
            inst.transform.localScale = Vector3.one * scale;
            b = CalcBounds(inst);
            inst.transform.localPosition = new Vector3(0, -b.min.y, 0);   // 脚踩地面
            root.AddComponent<DWAnimDriver>();
            // 占位武器姿态别扭，暂不挂；以后用真武器模型+实测偏移再绑（AttachWeapon 保留备用）
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
            e.plateH = 3.0f;
            players[id] = e;
        }

        void AddMonster(string id, float x, float z, string mstate, int hp, int maxHp, int tier, string name, int level = 1)
        {
            var e = new Ent { name = name, tier = tier, level = level, hp = hp, maxHp = maxHp, isMonster = true, target = new Vector3(x, 0, z) };
            e.go = MakeCreature(tier, id);
            e.go.transform.position = e.target;
            e.plateH = tier >= 5 ? (1.6f + tier * 0.55f) * 3f + 1.2f : 2.1f + tier * 0.55f;   // BOSS 放大3倍后名牌抬高到头顶
            monsters[id] = e;
            e.dead = mstate == "dead";
            e.go.SetActive(!e.dead);
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
                float target = 1.6f + tier * 0.55f;   // 放大怪物（BOSS tier5 更大）
                if (tier >= 5) target *= 3f;           // 世界BOSS体型再放大3倍
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
            if (tier >= 5) s *= 3f;   // 世界BOSS体型放大3倍（占位模型同样）
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
            var e = new Ent { name = "宠 " + name, tier = tier, hp = hp, maxHp = maxHp, isPet = true, target = new Vector3(x, 0, z) };
            e.go = new GameObject("Pet");
            var body = GameObject.CreatePrimitive(PrimitiveType.Sphere);
            body.transform.SetParent(e.go.transform, false);
            float s = 0.6f + tier * 0.25f;
            body.transform.localScale = Vector3.one * s;
            body.transform.localPosition = new Vector3(0, s * 0.5f, 0);
            Tint(body, Data.Hex("#7CFC9A"));
            e.go.transform.position = e.target;
            e.plateH = s + 0.8f;
            pets[ownerId] = e;
        }

        void RemoveEnt(Dictionary<string, Ent> dict, string id)
        {
            Ent e;
            if (dict.TryGetValue(id, out e)) { DestroyPlate(e); Destroy(e.go); dict.Remove(id); }
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
                if (e.hp != hp || e.level != lvl) { e.hp = hp; e.maxHp = max; e.level = lvl; }
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
                e.anim = (string)a[4];   // idle/chase/attack/dead → 驱动怪物动画
                bool deadNow = (string)a[4] == "dead";
                if (deadNow != e.dead) { e.dead = deadNow; e.go.SetActive(!deadNow); }
                int hp = (int)a[5];
                if (e.hp != hp) e.hp = hp;
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
                    if (e.hp != hp) e.hp = hp;
                }
            foreach (var id in new List<string>(pets.Keys)) if (!seenPet.Contains(id)) RemoveEnt(pets, id);
        }

        void OnDmg(JObject m)
        {
            var kind = (string)m["kind"];
            var id = (string)m["id"];
            int amt = (int)m["amt"], hp = (int)m["hp"];
            // 攻击方是怪物 → 播放它的攻击动作
            var by = (string)m["by"];
            if (by != null && monsters.TryGetValue(by, out var atk) && atk.go != null)
            {
                var ad = atk.go.GetComponent<DWAnimDriver>();
                if (ad != null) ad.PlayOnce("Attack1", 0.6f);
            }
            if (kind == "m")
            {
                Ent e;
                if (monsters.TryGetValue(id, out e))
                {
                    e.hp = hp;
                    bool crit = (int?)m["crit"] == 1;
                    FloatText((crit ? amt + " 暴击!" : amt.ToString()), e.target, (string)m["by"] == myId ? Color.yellow : Color.white);
                    if ((string)m["by"] == myId)
                    {
                        DWAudio.SfxAt("hit", e.target, pos, crit ? 0.85f : 0.6f);
                        if (SpawnFx("hit", e.target + Vector3.up * 1.0f, Quaternion.identity, crit ? 1.3f : 0.9f, 2f, dim: myDim) == null)
                            SpawnSparks(e.target + Vector3.up * 1.0f, crit ? new Color(1f, 0.85f, 0.2f) : new Color(1f, 0.95f, 0.8f), crit ? 16 : 8, crit ? 4.5f : 3.2f);
                    }
                }
            }
            else if (kind == "pet")
            {
                Ent e;
                if (pets.TryGetValue(id, out e)) e.hp = hp;
            }
            else
            {
                if (id == myId) { FloatText("-" + amt, pos, Color.red); Shake(0.2f, 0.18f); DWAudio.Sfx("hurt", 0.7f); }
                else
                {
                    Ent e;
                    if (players.TryGetValue(id, out e))
                    {
                        e.hp = hp;
                        FloatText(amt.ToString(), e.target, Color.white);
                    }
                }
            }
        }

        void SpawnProj(string id, float x, float z, float dx, float dz, float speed, Color c, string dim = null)
        {
            var go = GameObject.CreatePrimitive(PrimitiveType.Sphere);
            Destroy(go.GetComponent<Collider>());
            go.transform.localScale = Vector3.one * 0.5f;
            go.transform.position = new Vector3(x, 1.1f, z);
            Tint(go, c);
            var l = go.AddComponent<Light>();
            l.color = c; l.range = 6; l.intensity = 2.2f;
            var dir = new Vector3(dx, 0, dz);
            var fx = SpawnFx("proj", go.transform.position, dir.sqrMagnitude > 0.001f ? Quaternion.LookRotation(dir) : Quaternion.identity, 1f, 0f, killScripts: true, dim: dim == "mon" ? null : dim);
            if (fx != null)
            {
                fx.transform.SetParent(go.transform, true);   // 跟随服务器驱动的弹体移动
                var mr = go.GetComponent<MeshRenderer>(); if (mr != null) mr.enabled = false;   // 隐藏程序化球，只显示 Hovl 弹道
            }
            else
            {
                var tr = go.AddComponent<TrailRenderer>();
                tr.time = 0.22f; tr.startWidth = 0.5f; tr.endWidth = 0.02f; tr.numCapVertices = 2;
                tr.material = TrailMat(); tr.startColor = c; tr.endColor = new Color(c.r, c.g, c.b, 0f);
                tr.shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.Off;
            }
            projs[id] = new Proj { go = go, dir = dir, speed = speed, dieAt = Time.time + 3f };
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
                    // 点在 UGUI 按钮/面板上时不触发移动/转视角
                    var esT = UnityEngine.EventSystems.EventSystem.current;
                    if (esT != null && esT.IsPointerOverGameObject(t.fingerId)) continue;
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
                        camYaw -= t.deltaPosition.x * 0.004f;
                        camPitch = Mathf.Clamp(camPitch + t.deltaPosition.y * 0.003f, 0.55f, 1.4f);
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
                camYaw -= Input.GetAxis("Mouse X") * 0.03f;
                camPitch = Mathf.Clamp(camPitch + Input.GetAxis("Mouse Y") * 0.022f, 0.55f, 1.4f);
            }
            camDist = Mathf.Clamp(camDist - Input.GetAxis("Mouse ScrollWheel") * 6f, 5f, 16f);

            if (meDead)
            {
                if (Time.time - deadAt > 4f && Input.GetKeyDown(KeyCode.Space)) Send(new { t = "respawn" });
                return;
            }
            var es = UnityEngine.EventSystems.EventSystem.current;
            bool overUgui = es != null && es.IsPointerOverGameObject();
            if (!touching && Input.GetMouseButtonDown(0) && !MouseOverGui() && !overUgui) Cast("basic");
            if (Input.GetKeyDown(KeyCode.Q)) Cast("q");
            if (Input.GetKeyDown(KeyCode.E)) Cast("e");
            if (Input.GetKeyDown(KeyCode.R)) Cast("r");
            if (Input.GetKeyDown(KeyCode.B)) panelOpen = !panelOpen;
            if (Input.GetKeyDown(KeyCode.F) && Time.time > captureReadyAt)
            {
                captureReadyAt = Time.time + (dimSkillCd > 0 ? dimSkillCd : 3f);
                Send(new { t = "dimskill" });   // 各次元专属技能（猎人=捕捉）
            }
            if (Input.GetKeyDown(KeyCode.Space)) DoDodge();
        }

        void DoDodge()
        {
            if (meDead || Time.time <= dodgeReadyAt) return;
            dodgeReadyAt = Time.time + 1.2f;
            var mv = MoveVec();
            burstDir = mv.sqrMagnitude > 0.01f ? mv.normalized : new Vector3(Mathf.Sin(ry), 0, Mathf.Cos(ry));
            burstSpeed = 21f;
            burstUntil = Time.time + 0.24f;
            DWAudio.Sfx("dodge", 0.6f);
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
                pos = ResolveObstacles(pos, 0.6f);   // 撞树木/建筑停下
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
            if (def.minLvl > 0 && MyLevel < def.minLvl) { Toast($"【{def.name}】需要 Lv.{def.minLvl} 解锁"); return; }
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
            // 每个技能不同动作（按 q/e/r 分配不同动画，缺失则回退普攻）
            if (meDrv != null)
            {
                var an = SkillAnim(key);
                if (!meDrv.PlayOnce(an, 0.6f)) meDrv.PlayOnce("Attack1", 0.6f);
            }
            SkillCastFx(key, def.kind, pos, new Vector3(dx, 0, dz));   // 每个技能不同特效
            DWAudio.Sfx(def.kind == "proj" ? "laser" : (def.kind == "aoe" ? "explosion" : "swing"), 0.7f);
            Send(new { t = "cast", k = key, dx = Math.Round(dx, 3), dz = Math.Round(dz, 3) });
        }

        static string SkillAnim(string key)
        {
            switch (key) { case "basic": return "Attack1"; case "q": return "Attack2"; case "e": return "Skill"; default: return "Skill2"; }
        }

        /* 每个技能独立的施放特效（颜色/大小/形态不同） */
        void SkillCastFx(string key, string kind, Vector3 at, Vector3 dir)
        {
            // 每个「次元+职业+技能」固定散列 → 从特效池里各取一个不同特效；同时给程序化兜底略调色
            int seed = Mathf.Abs((myDim + "_" + myCls + "_" + key).GetHashCode());
            Color c = Color.Lerp(Data.Dim(myDim).accent, Color.HSVToRGB((seed % 100) / 100f, 0.7f, 1f), 0.22f);
            Color c2 = Color.Lerp(c, Color.white, 0.35f);
            Quaternion face = dir.sqrMagnitude > 0.001f ? Quaternion.LookRotation(dir) : Quaternion.identity;
            Vector3 p = at + dir * 1.3f + Vector3.up * 1.0f;
            if (kind == "aoe")
            {
                if (SpawnPoolFx("fxp_aoe", myDim, seed, at + Vector3.up * 0.1f, Quaternion.identity, key == "r" ? 1.3f : 1f, 3f) == null
                    && SpawnFx("aoe", at + Vector3.up * 0.1f, Quaternion.identity, 1f, 3f, dim: myDim) == null)
                { SpawnShockwave(at + Vector3.up * 0.1f, key == "r" ? 5.5f : 4f, c, "x", null); SpawnSparks(p, c2, 26, 7f); }
            }
            else if (kind == "aoeheal" || kind == "heal")
            {
                if (SpawnPoolFx("fxp_buff", null, seed, at + Vector3.up * 0.1f, Quaternion.identity, 1f, 3f) == null
                    && SpawnFx("heal", at + Vector3.up * 0.1f, Quaternion.identity, 1f, 3f, dim: myDim) == null)
                    SpawnShockwave(at + Vector3.up * 0.1f, 2.8f, Color.Lerp(c, new Color(0.3f, 1f, 0.5f), 0.6f), "x", null);
            }
            else if (kind == "dashmelee" || kind == "melee")
            {
                bool dash = kind == "dashmelee";
                if (SpawnPoolFx("fxp_slash", null, seed, p, face, dash ? 1.4f : 1.2f, 1.4f) == null
                    && SpawnFx("slash", p, face, dash ? 1.4f : 1.2f, 1.2f, dim: myDim) == null)
                {
                    SpawnSlash(at + Vector3.up * 0.05f, dir, c, dash ? 3.4f : 2.8f);
                    SpawnSparks(p, c2, dash ? 26 : 22, dash ? 7.5f : 6.5f); SpawnFlash(p, c, 2f);
                    if (dash) SpawnShockwave(at + dir * 1.4f + Vector3.up * 0.1f, 2.4f, c, "x", null);
                }
            }
            else   // proj：身前施法闪光（按次元元素）+ 火花
            {
                if (SpawnPoolFx("fxp_cast", myDim, seed, p, face, 1f, 1.4f) == null
                    && SpawnFx("cast", p, face, 1f, 1.5f, dim: myDim) == null)
                { SpawnSparks(p, c2, 18, 6f); SpawnFlash(p, c, 1.8f); }
            }
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
            if (!e.isPet)
            {
                var drv = e.go.GetComponent<DWAnimDriver>();
                if (!e.isMonster && e.dead)
                {
                    // 玩家：有死亡动画就播，否则占位小人倒地
                    if (drv == null || !drv.SetBase("Death"))
                        e.go.transform.rotation = Quaternion.Euler(85, e.tRy * Mathf.Rad2Deg, 0);
                }
                else
                {
                    // 怪物用 chase 状态判断奔跑；玩家用 anim=="run"
                    bool running = e.isMonster ? e.anim == "chase" : e.anim == "run";
                    if (drv != null) drv.SetBase(running ? "Run" : "Idle");
                    e.go.transform.rotation = Quaternion.Slerp(e.go.transform.rotation, Quaternion.Euler(0, e.tRy * Mathf.Rad2Deg, 0), k);
                }
            }
        }

        void Shake(float amp, float dur)
        {
            shakeAmp = Mathf.Max(shakeAmp, amp);
            shakeUntil = Mathf.Max(shakeUntil, Time.time + dur);
        }

        // 地面扩散光环 + 火花迸射 + 一闪而过的点光（被技能/BOSS/次元技共用）
        void SpawnShockwave(Vector3 at, float radius, Color c, string fx = "aoe", string dim = null)
        {
            // 有对应 Hovl 特效就用它（+一束补光），否则程序化光环兜底
            if (SpawnFx(fx, new Vector3(at.x, 0.12f, at.z), Quaternion.identity, Mathf.Clamp(radius / 4f, 0.7f, 3.5f), 3f, dim: dim) != null)
            {
                SpawnFlash(new Vector3(at.x, 0.6f, at.z), c, radius * 0.7f);
                return;
            }
            var go = GameObject.CreatePrimitive(PrimitiveType.Quad);
            Destroy(go.GetComponent<Collider>());
            go.name = "ringfx";
            go.transform.position = new Vector3(at.x, 0.06f, at.z);
            go.transform.rotation = Quaternion.Euler(90, 0, 0);   // 平铺地面
            var r = go.GetComponent<MeshRenderer>();
            r.shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.Off;
            r.receiveShadows = false;
            var mat = new Material(Shader.Find("Sprites/Default")) { mainTexture = RingTex() };
            r.material = mat;
            var ring = go.AddComponent<RingFx>(); ring.radius = radius; ring.col = c;
            var l = go.AddComponent<Light>(); l.color = c; l.range = radius * 2.2f; l.intensity = 4f;
            SpawnSparks(new Vector3(at.x, 0.6f, at.z), c, Mathf.Clamp((int)(radius * 4f), 12, 36), Mathf.Clamp(radius, 3f, 8f));
        }

        // 火花迸射（内置 ParticleSystem，无需素材）
        void SpawnSparks(Vector3 at, Color c, int count, float speed)
        {
            var go = new GameObject("sparks");
            go.transform.position = at;
            var ps = go.AddComponent<ParticleSystem>();
            ps.Stop(true, ParticleSystemStopBehavior.StopEmittingAndClear);   // 先停，否则配置 duration 会报"playing 中不可改"
            var main = ps.main;
            main.duration = 0.6f; main.loop = false; main.playOnAwake = false;
            main.startLifetime = 0.55f; main.startSpeed = speed; main.startSize = 0.34f;
            main.startColor = c; main.gravityModifier = 0.6f; main.maxParticles = count + 8;
            main.simulationSpace = ParticleSystemSimulationSpace.World;
            var em = ps.emission; em.rateOverTime = 0f;
            em.SetBursts(new[] { new ParticleSystem.Burst(0f, (short)count) });
            var sh = ps.shape; sh.shapeType = ParticleSystemShapeType.Sphere; sh.radius = 0.2f;
            var colol = ps.colorOverLifetime; colol.enabled = true;
            var grad = new Gradient();
            grad.SetKeys(new[] { new GradientColorKey(c, 0f), new GradientColorKey(c, 1f) },
                         new[] { new GradientAlphaKey(1f, 0f), new GradientAlphaKey(0f, 1f) });
            colol.color = grad;
            var sol = ps.sizeOverLifetime; sol.enabled = true;
            sol.size = new ParticleSystem.MinMaxCurve(1f, AnimationCurve.EaseInOut(0, 1, 1, 0));
            var rend = ps.GetComponent<ParticleSystemRenderer>();
            rend.material = SparkMat();
            rend.shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.Off;
            ps.Clear(); ps.Play();
            Destroy(go, 1.3f);
        }

        // 一闪而过的点光
        void SpawnFlash(Vector3 at, Color c, float range)
        {
            var go = new GameObject("flash"); go.transform.position = at;
            var l = go.AddComponent<Light>(); l.color = c; l.range = range * 3f; l.intensity = 4.5f;
            go.AddComponent<LightFade>();
        }

        // 程序化剑斩：身前一道发光弧光（贴地朝向攻击方向，快速放大淡出）
        void SpawnSlash(Vector3 at, Vector3 dir, Color c, float size)
        {
            var go = GameObject.CreatePrimitive(PrimitiveType.Quad);
            Destroy(go.GetComponent<Collider>());
            go.name = "slashfx";
            float yaw = (dir.sqrMagnitude > 0.001f ? Mathf.Atan2(dir.x, dir.z) : 0f) * Mathf.Rad2Deg;
            go.transform.position = at + dir.normalized * (size * 0.5f) + Vector3.up * 0.12f;
            go.transform.rotation = Quaternion.Euler(90, yaw, 0);   // 贴地、朝攻击方向
            var r = go.GetComponent<MeshRenderer>();
            r.shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.Off; r.receiveShadows = false;
            r.material = new Material(Shader.Find("Sprites/Default")) { mainTexture = SlashTex() };
            var fx = go.AddComponent<RingFx>(); fx.radius = size; fx.col = Color.Lerp(c, Color.white, 0.35f);
        }
        static Texture2D _slashTex;
        static Texture2D SlashTex()
        {
            if (_slashTex != null) return _slashTex;
            const int N = 128;
            var t = new Texture2D(N, N, TextureFormat.RGBA32, false) { wrapMode = TextureWrapMode.Clamp, filterMode = FilterMode.Bilinear };
            var px = new Color32[N * N];
            for (int y = 0; y < N; y++)
                for (int x = 0; x < N; x++)
                {
                    float u = (x + 0.5f) / N * 2f - 1f, v = (y + 0.5f) / N * 2f - 1f;
                    float d = Mathf.Sqrt(u * u + v * v);
                    float band = d > 1f ? 0f : Mathf.Clamp01(1f - Mathf.Abs(d - 0.72f) / 0.2f); band *= band;
                    float ang = Mathf.Atan2(v, u);                       // 只保留上半弧 → 月牙形剑光
                    float arc = (ang > 0.25f && ang < Mathf.PI - 0.25f) ? 1f : 0f;
                    px[y * N + x] = new Color32(255, 255, 255, (byte)(band * arc * 255));
                }
            t.SetPixels32(px); t.Apply(false); _slashTex = t; return t;
        }

        // ---- 程序化贴图/材质（生成一次缓存）----
        static Texture2D _ringTex, _dotTex;
        static Material _sparkMat, _trailMat;
        // 程序化地面纹理：灰度网格 + 细噪点（白底，运行时被地面材质的次元色相乘着色），让大平面不再死板
        static Texture2D _groundTex;
        static Texture2D GroundTex()
        {
            if (_groundTex != null) return _groundTex;
            const int N = 128;
            var t = new Texture2D(N, N, TextureFormat.RGBA32, true) { wrapMode = TextureWrapMode.Repeat, filterMode = FilterMode.Bilinear, anisoLevel = 2 };
            var rng = new System.Random(7);
            const int B = 8;                          // 低频斑块网格，双线性插值成柔和明暗
            var blob = new float[B + 1, B + 1];
            for (int j = 0; j <= B; j++) for (int i = 0; i <= B; i++) blob[i, j] = (float)(rng.NextDouble() * 0.18 - 0.09);
            var px = new Color32[N * N];
            for (int y = 0; y < N; y++)
                for (int x = 0; x < N; x++)
                {
                    float fx = (float)x / N * B, fy = (float)y / N * B;
                    int xi = (int)fx, yi = (int)fy; float tx = fx - xi, ty = fy - yi;
                    float bl = Mathf.Lerp(Mathf.Lerp(blob[xi, yi], blob[xi + 1, yi], tx), Mathf.Lerp(blob[xi, yi + 1], blob[xi + 1, yi + 1], tx), ty);
                    float v = 1f + bl + (float)(rng.NextDouble() * 0.05 - 0.025);   // 柔和斑块 + 细噪点
                    if (x < 1 || y < 1) v *= 0.82f;                                  // 很淡的格线
                    byte b = (byte)Mathf.Clamp(v * 255f, 0, 255);
                    px[y * N + x] = new Color32(b, b, b, 255);
                }
            t.SetPixels32(px); t.Apply(true); _groundTex = t; return t;
        }

        static Texture2D RingTex()
        {
            if (_ringTex != null) return _ringTex;
            const int N = 128; var t = new Texture2D(N, N, TextureFormat.RGBA32, false) { wrapMode = TextureWrapMode.Clamp };
            var px = new Color32[N * N];
            for (int y = 0; y < N; y++)
                for (int x = 0; x < N; x++)
                {
                    float u = (x + 0.5f) / N * 2f - 1f, v = (y + 0.5f) / N * 2f - 1f;
                    float d = Mathf.Sqrt(u * u + v * v);
                    float a = d > 1f ? 0f : Mathf.Clamp01(1f - Mathf.Abs(d - 0.74f) / 0.24f); a *= a;
                    px[y * N + x] = new Color32(255, 255, 255, (byte)(a * 255));
                }
            t.SetPixels32(px); t.Apply(false); _ringTex = t; return t;
        }
        static Texture2D DotTex()
        {
            if (_dotTex != null) return _dotTex;
            const int N = 32; var t = new Texture2D(N, N, TextureFormat.RGBA32, false) { wrapMode = TextureWrapMode.Clamp };
            var px = new Color32[N * N];
            for (int y = 0; y < N; y++)
                for (int x = 0; x < N; x++)
                {
                    float u = (x + 0.5f) / N * 2f - 1f, v = (y + 0.5f) / N * 2f - 1f;
                    float a = Mathf.Clamp01(1f - Mathf.Sqrt(u * u + v * v)); a *= a;
                    px[y * N + x] = new Color32(255, 255, 255, (byte)(a * 255));
                }
            t.SetPixels32(px); t.Apply(false); _dotTex = t; return t;
        }
        static Material SparkMat()
        {
            if (_sparkMat == null) _sparkMat = new Material(Shader.Find("Sprites/Default")) { mainTexture = DotTex() };
            return _sparkMat;
        }
        static Material TrailMat()
        {
            if (_trailMat == null) _trailMat = new Material(Shader.Find("Sprites/Default")) { mainTexture = Texture2D.whiteTexture };
            return _trailMat;
        }

        // ---- Hovl 等已购特效（向导复制进 Resources/DWFx），按名加载；缺失则返回 null 由调用方程序化兜底 ----
        static readonly Dictionary<string, GameObject> _fxCache = new Dictionary<string, GameObject>();
        static GameObject FxPrefab(string name)
        {
            if (_fxCache.TryGetValue(name, out var p)) return p;
            p = Resources.Load<GameObject>("DWFx/" + name);
            _fxCache[name] = p;
            return p;
        }
        // 检测特效是否用了缺失/不可用的 shader（在内置管线会渲染成洋红）→ 跳过改用程序化兜底
        static readonly Dictionary<GameObject, bool> _fxBroken = new Dictionary<GameObject, bool>();
        static bool FxBroken(GameObject pf)
        {
            if (_fxBroken.TryGetValue(pf, out var b)) return b;
            b = false;
            foreach (var r in pf.GetComponentsInChildren<Renderer>(true))
            {
                foreach (var m in r.sharedMaterials)
                {
                    var sh = m != null ? m.shader : null;
                    if (sh == null || !sh.isSupported || sh.name == "Hidden/InternalErrorShader") { b = true; break; }
                }
                if (b) break;
            }
            _fxBroken[pf] = b;
            return b;
        }
        GameObject InstFx(GameObject pf, Vector3 at, Quaternion rot, float scale, float life, bool killScripts)
        {
            var go = Instantiate(pf, at, rot);
            if (!Mathf.Approximately(scale, 1f)) go.transform.localScale *= scale;
            if (killScripts)
                foreach (var mb in go.GetComponentsInChildren<MonoBehaviour>(true)) if (mb != null) mb.enabled = false;  // 关掉自带位移脚本（弹道由我们驱动）
            foreach (var r in go.GetComponentsInChildren<Renderer>(true)) r.shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.Off;
            if (life > 0) Destroy(go, life);
            return go;
        }
        GameObject SpawnFx(string name, Vector3 at, Quaternion rot, float scale = 1f, float life = 2.5f, bool killScripts = false, string dim = null)
        {
            var pf = dim != null ? FxPrefab(name + "_" + dim) : null;   // 优先次元专属变体
            if (pf == null) pf = FxPrefab(name);
            if (pf == null || FxBroken(pf)) return null;   // 缺失或 shader 不可用(变粉) → 交给程序化兜底
            return InstFx(pf, at, rot, scale, life, killScripts);
        }
        // 特效池：DWFx 里所有以 cat 开头、可正常渲染的预制体，按技能稳定散列取用 → 每技能不同特效
        static readonly Dictionary<string, GameObject[]> _fxPools = new Dictionary<string, GameObject[]>();
        static GameObject[] FxPool(string cat)
        {
            if (_fxPools.TryGetValue(cat, out var arr)) return arr;
            var list = new List<GameObject>();
            foreach (var g in Resources.LoadAll<GameObject>("DWFx"))
            {
                var nm = g != null ? g.name : null;
                if (nm == null || !nm.StartsWith(cat)) continue;
                if (nm.Length <= cat.Length || !char.IsDigit(nm[cat.Length])) continue;   // cat 后必须紧跟数字，避免 fxp_aoe 误吞 fxp_aoe_tech
                if (!FxBroken(g)) list.Add(g);
            }
            arr = list.ToArray(); _fxPools[cat] = arr; return arr;
        }
        // dim!=null 时优先取该次元元素专属池(cat_dim)，否则通用池(cat)
        GameObject SpawnPoolFx(string cat, string dim, int seed, Vector3 at, Quaternion rot, float scale = 1f, float life = 2.5f)
        {
            var pool = dim != null ? FxPool(cat + "_" + dim) : null;
            if (pool == null || pool.Length == 0) pool = FxPool(cat);
            if (pool.Length == 0) return null;
            return InstFx(pool[Mathf.Abs(seed) % pool.Length], at, rot, scale, life, false);
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
            if (cam == null || state != State.Playing) return;
            // UGUI 名牌：逐帧把世界坐标投影到屏幕、更新血条（在相机移动后）
            UpdatePlateGroup(players, false);
            UpdatePlateGroup(monsters, true);
            UpdatePlateGroup(pets, false);
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

        public bool PlayOnce(string s, float dur)
        {
            if (!Has(s)) return false;
            an.CrossFadeInFixedTime(Animator.StringToHash(s), 0.05f, 0, 0f);
            applied = s;
            oneUntil = Time.time + dur;
            return true;
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

    // 地面扩散光环：平铺四边形随时间放大并淡出（替代旧的实心圆盘）
    public class RingFx : MonoBehaviour
    {
        public float radius = 5f;
        public Color col = Color.white;
        float born; Material mat; Light l;
        void Start() { born = Time.time; var r = GetComponent<MeshRenderer>(); if (r != null) mat = r.material; l = GetComponent<Light>(); }
        void Update()
        {
            float k = (Time.time - born) / 0.55f;
            if (k >= 1f) { Destroy(gameObject); return; }
            float d = Mathf.Lerp(radius * 0.5f, radius * 2.1f, Mathf.Sqrt(k));   // 直径，缓出
            transform.localScale = new Vector3(d, d, 1f);
            if (mat != null) { var c = col; c.a = (1f - k) * 0.95f; mat.color = c; }
            if (l != null) l.intensity = 4f * (1f - k);
        }
    }

    // 一闪而过的点光淡出
    public class LightFade : MonoBehaviour
    {
        float born; Light l;
        void Start() { born = Time.time; l = GetComponent<Light>(); }
        void Update()
        {
            float k = (Time.time - born) / 0.25f;
            if (k >= 1f) { Destroy(gameObject); return; }
            if (l != null) l.intensity = 4.5f * (1f - k);
        }
    }

    // 屏幕空间伤害/治疗飘字：向上飘动并淡出
    public class UiFloat : MonoBehaviour
    {
        float born;
        RectTransform rt;
        Text txt;
        Color c0;
        void Start()
        {
            born = Time.time;
            rt = (RectTransform)transform;
            txt = GetComponent<Text>();
            if (txt != null) c0 = txt.color;
        }
        void Update()
        {
            float a = Time.time - born;
            if (rt != null) rt.localPosition += Vector3.up * 70f * Time.deltaTime;
            if (txt != null) { var c = c0; c.a = Mathf.Clamp01(1.2f - a); txt.color = c; }
            if (a > 1.1f) Destroy(gameObject);
        }
    }
}
