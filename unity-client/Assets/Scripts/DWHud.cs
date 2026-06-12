/* ============================================================
 * 次元大战 Unity 客户端 - 界面（IMGUI 版，后续可升级 UGUI/UIToolkit）
 * ============================================================ */
using System.Collections.Generic;
using Newtonsoft.Json.Linq;
using UnityEngine;

namespace DW
{
    public partial class Game
    {
        bool panelOpen;
        int panelTab;
        Vector2 panelScroll;
        readonly List<Rect> guiRects = new List<Rect>();

        bool MouseOverGui()
        {
            var mp = new Vector2(Input.mousePosition.x, Screen.height - Input.mousePosition.y);
            foreach (var r in guiRects) if (r.Contains(mp)) return true;
            return false;
        }

        GUIStyle _label, _title, _btn, _box;
        void EnsureStyles()
        {
            if (_label != null) return;
            _label = new GUIStyle(GUI.skin.label) { fontSize = 15, richText = true };
            _title = new GUIStyle(GUI.skin.label) { fontSize = 26, fontStyle = FontStyle.Bold, alignment = TextAnchor.MiddleCenter };
            _btn = new GUIStyle(GUI.skin.button) { fontSize = 15 };
            _box = new GUIStyle(GUI.skin.box) { fontSize = 14 };
            if (cjkFont != null)
            {
                GUI.skin.font = cjkFont;
                _label.font = _title.font = _btn.font = _box.font = cjkFont;
            }
        }

        void OnGUI()
        {
            EnsureStyles();
            guiRects.Clear();
            switch (state)
            {
                case State.Menu: GuiMenu(); break;
                case State.Connecting:
                    GUI.Label(new Rect(0, Screen.height / 2f - 20, Screen.width, 40), "🌌 正在连接次元…", _title);
                    break;
                case State.Playing: GuiHud(); break;
            }
            if (Time.time < toastUntil)
                GUI.Label(new Rect(0, Screen.height - 150, Screen.width, 30), $"<b>{toastMsg}</b>", new GUIStyle(_label) { alignment = TextAnchor.MiddleCenter, fontSize = 17 });
        }

        void GuiMenu()
        {
            float w = 460, h = 480;
            var r = new Rect((Screen.width - w) / 2, (Screen.height - h) / 2, w, h);
            guiRects.Add(r);
            GUI.Box(r, "", _box);
            GUILayout.BeginArea(new Rect(r.x + 24, r.y + 16, w - 48, h - 32));
            GUILayout.Label("🌌 次元大战", _title);
            GUILayout.Space(8);
            GUILayout.Label("服务器地址（IP 或 IP:端口）", _label);
            serverIp = GUILayout.TextField(serverIp, GUILayout.Height(30));
            GUILayout.Label("降临者之名", _label);
            playerName = GUILayout.TextField(playerName, 12, GUILayout.Height(30));

            GUILayout.Label("选择次元", _label);
            GUILayout.BeginHorizontal();
            for (int i = 0; i < Data.Dims.Length; i++)
            {
                GUI.backgroundColor = i == dimIdx ? Data.Dims[i].accent : Color.white;
                if (GUILayout.Button(Data.Dims[i].name.Replace("世界", ""), _btn, GUILayout.Height(34))) dimIdx = i;
            }
            GUI.backgroundColor = Color.white;
            GUILayout.EndHorizontal();
            if (Data.Dims[dimIdx].id == "hunter")
                GUILayout.Label("<color=#ffd166>次元天赋：可捕捉野怪当宝宝（F键）</color>", _label);

            GUILayout.Label("选择职业", _label);
            GUILayout.BeginHorizontal();
            for (int i = 0; i < Data.Classes.Length; i++)
            {
                GUI.backgroundColor = i == clsIdx ? Data.Hex("#ffd166") : Color.white;
                var title = Data.ClassTitle(Data.Dims[dimIdx].id, Data.Classes[i].id);
                if (GUILayout.Button($"{title}\n({Data.Classes[i].role})", _btn, GUILayout.Height(46))) clsIdx = i;
            }
            GUI.backgroundColor = Color.white;
            GUILayout.EndHorizontal();

            GUILayout.Space(14);
            GUI.enabled = playerName.Trim().Length > 0;
            if (GUILayout.Button("⚔ 降临次元", new GUIStyle(_btn) { fontSize = 20 }, GUILayout.Height(46))) Join();
            GUI.enabled = true;
            GUILayout.Space(6);
            GUILayout.Label("<size=12>WASD移动 · 右键转视角 · 左键普攻 · QER技能 · 空格翻滚 · F捕捉 · B面板</size>", _label);
            GUILayout.EndArea();
        }

        void GuiHud()
        {
            // 左上：状态
            var tl = new Rect(12, 10, 360, 110);
            guiRects.Add(tl);
            GUI.Box(tl, "", _box);
            int hp = you != null ? (int?)you["hp"] ?? 0 : 0;
            int maxHp = you != null ? (int?)you["maxHp"] ?? 1 : 1;
            int exp = you != null ? (int?)you["exp"] ?? 0 : 0;
            int expNeed = you != null ? (int?)you["expNeed"] ?? 1 : 1;
            int gold = you != null ? (int?)you["gold"] ?? 0 : 0;
            var roomName = curRoom == "war" ? "🌀 重叠战场" : Data.Dim(myDim).name;
            GUI.Label(new Rect(20, 14, 340, 22), $"<b>{roomName}</b> ｜ {Data.ClassTitle(myDim, myCls)}", _label);
            DrawBar(new Rect(20, 40, 280, 16), (float)hp / maxHp, Color.green, $"{hp}/{maxHp}");
            DrawBar(new Rect(20, 60, 280, 8), (float)exp / expNeed, Data.Hex("#ffd166"), "");
            GUI.Label(new Rect(20, 74, 340, 22),
                $"Lv.{MyLevel} ｜ 💰{gold}" + (MySkPts > 0 ? $" ｜ <color=#ffd166>✨技能点×{MySkPts}</color>" : ""), _label);

            // 战场横幅
            if (warInfo != null && (bool?)warInfo["active"] == true)
            {
                var wr = new Rect(Screen.width / 2f - 260, 8, 520, 36);
                guiRects.Add(wr);
                GUI.Box(wr, "", _box);
                string a = (string)warInfo["a"], b = (string)warInfo["b"];
                GUI.Label(new Rect(wr.x + 10, wr.y + 6, 360, 24),
                    $"🌀 {Data.Dim(a).name} {warInfo["killsA"]} : {warInfo["killsB"]} {Data.Dim(b).name}", _label);
                if (myDim == a || myDim == b)
                {
                    if (GUI.Button(new Rect(wr.xMax - 130, wr.y + 4, 122, 28), curRoom == "war" ? "↩ 撤离战场" : "⚔ 进入战场", _btn))
                        Send(new { t = "war", enter = curRoom == "war" ? 0 : 1 });
                }
            }

            // 右上按钮
            var bagR = new Rect(Screen.width - 56, 10, 44, 40);
            guiRects.Add(bagR);
            if (GUI.Button(bagR, "🎒", _btn)) panelOpen = !panelOpen;

            // 消息流
            for (int i = 0; i < feed.Count; i++)
            {
                if (Time.time - feedAt[i] > 12f) continue;
                GUI.Label(new Rect(Screen.width - 430, 60 + i * 22, 420, 22), $"<size=13>{feed[i]}</size>", _label);
            }

            GuiSkillBar();
            if (panelOpen) GuiPanel();
            if (meDead) GuiDeath();
        }

        void DrawBar(Rect r, float pct, Color c, string txt)
        {
            GUI.color = new Color(0, 0, 0, 0.6f);
            GUI.DrawTexture(r, Texture2D.whiteTexture);
            GUI.color = c;
            GUI.DrawTexture(new Rect(r.x + 1, r.y + 1, (r.width - 2) * Mathf.Clamp01(pct), r.height - 2), Texture2D.whiteTexture);
            GUI.color = Color.white;
            if (txt.Length > 0)
                GUI.Label(new Rect(r.x, r.y - 3, r.width, r.height + 6), $"<size=11><b> {txt}</b></size>", _label);
        }

        void GuiSkillBar()
        {
            var keys = new[] { "basic", "q", "e", "r" };
            var keyLabels = new[] { "左键", "Q", "E", "R" };
            float slotW = 86, gap = 8;
            int extra = myDim == "hunter" ? 2 : 1;
            float total = (keys.Length + extra) * (slotW + gap);
            float x0 = (Screen.width - total) / 2, y0 = Screen.height - 92;
            var def = Data.Cls(myCls);

            for (int i = 0; i < keys.Length; i++)
            {
                var sk = def.Skill(keys[i]);
                var r = new Rect(x0 + i * (slotW + gap), y0, slotW, 76);
                guiRects.Add(r);
                bool locked = sk.minLvl > 0 && MyLevel < sk.minLvl;
                float ready;
                readyAt.TryGetValue(keys[i], out ready);
                float cdRemain = Mathf.Max(0, ready - Time.time);
                GUI.Box(r, "", _box);
                GUI.Label(new Rect(r.x + 6, r.y + 4, slotW - 8, 18), $"<size=11><color=#ffd166>{keyLabels[i]}</color> Lv{MySkLvl(keys[i])}</size>", _label);
                GUI.Label(new Rect(r.x + 6, r.y + 22, slotW - 8, 20), locked ? $"<color=#888>{sk.name}🔒</color>" : sk.name, _label);
                if (cdRemain > 0)
                    GUI.Label(new Rect(r.x + 6, r.y + 44, slotW - 8, 20), $"<color=#aaa>{cdRemain:0.0}s</color>", _label);
                else if (GUI.Button(new Rect(r.x + 6, r.y + 44, slotW - 12, 24), "施放", _btn)) Cast(keys[i]);
                // 技能加点
                if (MySkPts > 0 && !locked && MySkLvl(keys[i]) < 5)
                {
                    var pr = new Rect(r.xMax - 26, r.y - 12, 26, 26);
                    guiRects.Add(pr);
                    GUI.backgroundColor = Data.Hex("#ffd166");
                    if (GUI.Button(pr, "+", _btn)) Send(new { t = "sklvl", k = keys[i] });
                    GUI.backgroundColor = Color.white;
                }
            }
            // 翻滚
            var dr = new Rect(x0 + keys.Length * (slotW + gap), y0, slotW, 76);
            guiRects.Add(dr);
            GUI.Box(dr, "", _box);
            float dRemain = Mathf.Max(0, dodgeReadyAt - Time.time);
            GUI.Label(new Rect(dr.x + 6, dr.y + 4, slotW, 18), "<size=11><color=#ffd166>空格</color></size>", _label);
            GUI.Label(new Rect(dr.x + 6, dr.y + 22, slotW, 20), "翻滚", _label);
            if (dRemain > 0) GUI.Label(new Rect(dr.x + 6, dr.y + 44, slotW, 20), $"<color=#aaa>{dRemain:0.0}s</color>", _label);
            // 捕捉（猎人）
            if (myDim == "hunter")
            {
                var cr = new Rect(x0 + (keys.Length + 1) * (slotW + gap), y0, slotW, 76);
                guiRects.Add(cr);
                GUI.Box(cr, "", _box);
                float cRemain = Mathf.Max(0, captureReadyAt - Time.time);
                GUI.Label(new Rect(cr.x + 6, cr.y + 4, slotW, 18), "<size=11><color=#ffd166>F</color></size>", _label);
                GUI.Label(new Rect(cr.x + 6, cr.y + 22, slotW, 20), "🐾捕捉", _label);
                if (cRemain > 0) GUI.Label(new Rect(cr.x + 6, cr.y + 44, slotW, 20), $"<color=#aaa>{cRemain:0.0}s</color>", _label);
            }
        }

        void GuiDeath()
        {
            var r = new Rect(Screen.width / 2f - 180, Screen.height / 2f - 80, 360, 150);
            guiRects.Add(r);
            GUI.Box(r, "", _box);
            GUI.Label(new Rect(r.x, r.y + 16, r.width, 32), "💀 你已阵亡", new GUIStyle(_title) { fontSize = 22 });
            float remain = Mathf.Max(0, 4f - (Time.time - deadAt));
            if (remain > 0)
                GUI.Label(new Rect(r.x, r.y + 60, r.width, 26), $"复活倒计时 {remain:0.0}s", new GUIStyle(_label) { alignment = TextAnchor.MiddleCenter });
            else if (GUI.Button(new Rect(r.x + 90, r.y + 60, 180, 40), "⚔ 立即复活", _btn))
                Send(new { t = "respawn" });
        }

        void GuiPanel()
        {
            float w = 460, h = Mathf.Min(620, Screen.height - 120);
            var r = new Rect(Screen.width - w - 12, 60, w, h);
            guiRects.Add(r);
            GUI.Box(r, "", _box);
            GUILayout.BeginArea(new Rect(r.x + 14, r.y + 10, w - 28, h - 20));
            GUILayout.BeginHorizontal();
            var tabs = new[] { "📊 属性", "🎒 背包·装备", "🛒 商店" };
            for (int i = 0; i < tabs.Length; i++)
            {
                GUI.backgroundColor = panelTab == i ? Data.Hex("#ffd166") : Color.white;
                if (GUILayout.Button(tabs[i], _btn, GUILayout.Height(30))) panelTab = i;
            }
            GUI.backgroundColor = Color.white;
            if (GUILayout.Button("✕", _btn, GUILayout.Width(34), GUILayout.Height(30))) panelOpen = false;
            GUILayout.EndHorizontal();
            panelScroll = GUILayout.BeginScrollView(panelScroll);
            if (panelTab == 0) GuiStats();
            else if (panelTab == 1) GuiBag();
            else GuiShop();
            GUILayout.EndScrollView();
            GUILayout.EndArea();
        }

        void GuiStats()
        {
            if (you == null) { GUILayout.Label("等待服务器数据…", _label); return; }
            var def = Data.Cls(myCls);
            GUILayout.Label($"<b>{def.icon} {Data.ClassTitle(myDim, myCls)}</b>（{def.role}）", _label);
            GUILayout.Label($"📈 等级 Lv.{you["level"]}（经验 {you["exp"]}/{you["expNeed"]}）", _label);
            GUILayout.Label($"❤ 体力(生命上限)：{you["maxHp"]}（当前 {you["hp"]}）", _label);
            GUILayout.Label($"⚔ 物理攻击：{you["patk"]}    🔮 法术攻击：{you["matk"]}", _label);
            GUILayout.Label($"🛡 物理防御：{you["armor"]}    ✨ 法术防御：{you["mres"]}", _label);
            GUILayout.Label($"👟 移动速度：{you["spd"]}    💰 金币：{you["gold"]}", _label);
            GUILayout.Label($"🗡 击杀：野怪{you["kills"]} / 玩家{you["pvpKills"]}", _label);
            GUILayout.Label($"✨ 技能点：{MySkPts}（升级获得，技能栏点＋加点）", _label);
            GUILayout.Space(8);
            GUILayout.Label("<b>技能</b>", _label);
            foreach (var sk in def.skills)
                GUILayout.Label($"<b>{sk.name}</b> <color=#ffd166>Lv.{MySkLvl(sk.key)}/5</color>\n<size=12><color=#999>{sk.desc}</color></size>", _label);
        }

        string ItemStats(JObject it)
        {
            var parts = new List<string>();
            if (it["patk"] != null) parts.Add($"物攻+{it["patk"]}");
            if (it["matk"] != null) parts.Add($"法攻+{it["matk"]}");
            if (it["armor"] != null) parts.Add($"物防+{it["armor"]}");
            if (it["mres"] != null) parts.Add($"法防+{it["mres"]}");
            if (it["hp"] != null) parts.Add($"生命+{it["hp"]}");
            if (it["spd"] != null) parts.Add($"移速+{it["spd"]}");
            return string.Join(" ", parts);
        }

        string RarColor(JObject it) => ColorUtility.ToHtmlStringRGB(Data.RarityColors[Mathf.Clamp((int?)it["rar"] ?? 0, 0, 4)]);

        void GuiBag()
        {
            GUILayout.Label("<b>已装备</b>（点击卸下）", _label);
            if (equipData != null)
                foreach (var slot in Data.SlotNames)
                {
                    var it = equipData[slot.Key] as JObject;
                    if (it == null) { GUILayout.Label($"{slot.Value}：<color=#777>空</color>", _label); continue; }
                    GUILayout.BeginHorizontal();
                    GUILayout.Label($"{slot.Value}：<color=#{RarColor(it)}>{it["name"]}</color> <size=12>{ItemStats(it)}</size>", _label);
                    if (GUILayout.Button("卸下", _btn, GUILayout.Width(60))) Send(new { t = "unequip", slot = slot.Key });
                    GUILayout.EndHorizontal();
                }
            GUILayout.Space(8);
            GUILayout.Label($"<b>背包</b>（{(invData != null ? invData.Count : 0)}/24）", _label);
            if (invData != null)
                for (int i = 0; i < invData.Count; i++)
                {
                    var it = (JObject)invData[i];
                    int val = (int?)it["val"] ?? 0;
                    GUILayout.BeginHorizontal();
                    GUILayout.Label($"<color=#{RarColor(it)}>{it["name"]}</color> <size=12>{ItemStats(it)}</size>", _label);
                    if (GUILayout.Button("装备", _btn, GUILayout.Width(60))) Send(new { t = "equip", i });
                    if (GUILayout.Button($"卖{val * 2 / 5}金", _btn, GUILayout.Width(86))) Send(new { t = "sell", i });
                    GUILayout.EndHorizontal();
                }
        }

        void GuiShop()
        {
            int gold = you != null ? (int?)you["gold"] ?? 0 : 0;
            GUILayout.Label($"<b>商店</b>（金币：💰{gold}）", _label);
            if (shopData == null) { GUILayout.Label("…", _label); return; }
            foreach (JObject it in shopData)
            {
                GUILayout.BeginHorizontal();
                string slotName;
                Data.SlotNames.TryGetValue((string)it["slot"] ?? "", out slotName);
                GUILayout.Label($"<color=#{RarColor(it)}>{it["name"]}</color> <size=12>[{slotName}] {ItemStats(it)}</size>", _label);
                if (GUILayout.Button($"💰{it["price"]}", _btn, GUILayout.Width(90))) Send(new { t = "buy", id = (string)it["id"] });
                GUILayout.EndHorizontal();
            }
        }
    }
}
