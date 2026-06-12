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
        JObject you;            // 服务器下发的完整属性
        JObject warInfo;
        protected JObject bossInfo;
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
        float burstUntil, burstSpeed;
        Vector3 burstDir;
        float lastMvSent;

        readonly List<GameObject> worldObjs = new List<GameObject>();
        readonly List<string> feed = new List<string>();
        readonly List<float> feedAt = new List<float>();
        string toastMsg = "";
        float toastUntil;

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
                    EnterRoom((string)m["room"], m);
                    if (m["war"] != null) warInfo = (JObject)m["war"];
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
                    var color = Data.Dim((string)m["dim"]).accent;
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
                    if ((string)m["id"] == myId) Toast($"🆙 升级到 Lv.{(int)m["level"]}！获得技能点");
                    break;
                case "cast":
                {
                    Ent e;
                    if (players.TryGetValue((string)m["id"], out e))
                        e.tRy = Mathf.Atan2((float)m["dx"], (float)m["dz"]);
                    break;
                }
                case "war":
                    if (m["state"] != null) warInfo = (JObject)m["state"];
                    break;
                case "boss":
                    bossInfo = ((int?)m["alive"] ?? 0) == 1 ? m : null;
                    break;
                case "baoe":
                {
                    // 世界BOSS震地：红色冲击波 + 若我在范围附近则镜头震动
                    var at = new Vector3((float)m["x"], 0.2f, (float)m["z"]);
                    SpawnShockwave(at, (float?)m["r"] ?? 7f, new Color(1f, 0.2f, 0.27f));
                    if ((at - pos).sqrMagnitude < 14f * 14f) Shake(0.45f, 0.5f);
                    break;
                }
                case "feed": Feed((string)m["msg"]); break;
                case "chat": Feed($"💬 {(string)m["name"]}：{(string)m["msg"]}"); break;
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
            meGo = MakeHumanoid(Data.Dim(myDim).accent, myCls == "tank" ? 1.12f : 1f);
            meGo.name = "Me";

            if (m["players"] != null)
                foreach (JObject p in (JArray)m["players"]) AddPlayer(p);
        }

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
            ground.transform.localScale = new Vector3(16, 1, 16); // 160×160
            Tint(ground, theme.ground);
            worldObjs.Add(ground);

            var sun = new GameObject("Sun").AddComponent<Light>();
            sun.type = LightType.Directional;
            sun.intensity = 1.1f;
            sun.transform.rotation = Quaternion.Euler(50, -30, 0);
            worldObjs.Add(sun.gameObject);

            // 简易摆件（占位：等导入正式美术包后替换为场景资产）
            var rng = new System.Random(theme.id.GetHashCode());
            for (int i = 0; i < 60; i++)
            {
                var o = GameObject.CreatePrimitive(rng.NextDouble() < 0.5 ? PrimitiveType.Cube : PrimitiveType.Cylinder);
                float a = (float)(rng.NextDouble() * Math.PI * 2);
                float r = 15 + (float)rng.NextDouble() * (Data.MapHalf - 20);
                float h = 1.5f + (float)rng.NextDouble() * 5f;
                o.transform.position = new Vector3(Mathf.Cos(a) * r, h / 2, Mathf.Sin(a) * r);
                o.transform.localScale = new Vector3(1.2f, h, 1.2f);
                Tint(o, Color.Lerp(theme.ground * 1.8f, theme.accent, 0.12f));
                worldObjs.Add(o);
            }
        }

        static void Tint(GameObject go, Color c)
        {
            var r = go.GetComponent<Renderer>();
            if (r != null) r.material.color = c;
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
            var tm = go.AddComponent<TextMesh>();
            tm.anchor = TextAnchor.MiddleCenter;
            tm.alignment = TextAlignment.Center;
            tm.characterSize = 0.085f;
            tm.fontSize = 48;
            if (cjkFont != null)
            {
                tm.font = cjkFont;
                go.GetComponent<MeshRenderer>().material = cjkFont.material;
            }
            return tm;
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
            e.go = MakeHumanoid(Data.Dim(dim).accent, e.cls == "tank" ? 1.12f : 1f);
            e.go.transform.position = e.target;
            e.label = MakeLabel(e.go, 2.6f);
            players[id] = e;
            UpdateLabel(e, dim == myDim ? "#7CFC9A" : "#ff7788");
        }

        void AddMonster(string id, float x, float z, string mstate, int hp, int maxHp, int tier, string name)
        {
            var theme = curRoom == "war" ? Data.WarDim : Data.Dim(myDim);
            var e = new Ent { name = name, tier = tier, hp = hp, maxHp = maxHp, isMonster = true, target = new Vector3(x, 0, z) };
            e.go = new GameObject("Monster");
            var body = GameObject.CreatePrimitive(PrimitiveType.Sphere);
            body.transform.SetParent(e.go.transform, false);
            float s = 0.9f + tier * 0.45f;
            body.transform.localScale = new Vector3(s, s * 0.85f, s);
            body.transform.localPosition = new Vector3(0, s * 0.45f, 0);
            Tint(body, Color.Lerp(new Color(0.5f, 0.45f, 0.5f), theme.accent, 0.45f));
            e.go.transform.position = e.target;
            e.label = MakeLabel(e.go, s * 0.9f + 0.9f);
            monsters[id] = e;
            e.dead = mstate == "dead";
            e.go.SetActive(!e.dead);
            UpdateLabel(e, "#ffaa33");
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
            string title = e.isMonster ? $"{e.name} T{e.tier}" : e.isPet ? e.name : $"{e.name} Lv.{e.level}";
            e.label.text = $"{title}\n{e.hp}/{e.maxHp}";
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
                    AddMonster(id, (float)a[1], (float)a[2], (string)a[4], (int)a[5], (int)a[6], (int)a[7], (string)a[8]);
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
                    var guiPos = new Vector2(t.position.x, Screen.height - t.position.y);
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
            if (Input.GetKeyDown(KeyCode.F) && myDim == "hunter" && Time.time > captureReadyAt)
            {
                captureReadyAt = Time.time + 3f;
                Send(new { t = "capture" });
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

        Vector3 MoveVec()
        {
            float fx = moveTouchVec.x, fz = moveTouchVec.y;
            if (Input.GetKey(KeyCode.W)) fz += 1;
            if (Input.GetKey(KeyCode.S)) fz -= 1;
            if (Input.GetKey(KeyCode.A)) fx -= 1;
            if (Input.GetKey(KeyCode.D)) fx += 1;
            if (Mathf.Abs(fx) < 0.12f && Mathf.Abs(fz) < 0.12f) return Vector3.zero;
            var v = Vector3.ClampMagnitude(new Vector3(fx, 0, fz), 1f);
            float s = Mathf.Sin(camYaw), c = Mathf.Cos(camYaw);
            return new Vector3(v.x * c - v.z * s, 0, v.x * -s - v.z * c);
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
                if (e.dead) e.go.transform.rotation = Quaternion.Euler(85, e.tRy * Mathf.Rad2Deg, 0);
                else e.go.transform.rotation = Quaternion.Slerp(e.go.transform.rotation, Quaternion.Euler(0, e.tRy * Mathf.Rad2Deg, 0), k);
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
