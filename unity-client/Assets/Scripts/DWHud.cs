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
        protected bool chatOpen;
        string chatText = "";
        int panelTab;
        Vector2 panelScroll;
        readonly List<Rect> guiRects = new List<Rect>();

        /* 高分屏 UI 缩放：以 900p 为基准放大，所有界面坐标用逻辑尺寸 SW/SH */
        protected float uiScale = 1f;
        float SW => Screen.width / uiScale;
        float SH => Screen.height / uiScale;

        bool MouseOverGui()
        {
            var mp = new Vector2(Input.mousePosition.x / uiScale, SH - Input.mousePosition.y / uiScale);
            foreach (var r in guiRects) if (r.Contains(mp)) return true;
            return false;
        }

        GUIStyle _label, _title, _btn, _box;
        void EnsureStyles()
        {
            if (_label != null) return;
            _label = new GUIStyle(GUI.skin.label) { fontSize = 17, richText = true };
            _title = new GUIStyle(GUI.skin.label) { fontSize = 30, fontStyle = FontStyle.Bold, alignment = TextAnchor.MiddleCenter };
            _btn = new GUIStyle(GUI.skin.button) { fontSize = 18 };
            _box = new GUIStyle(GUI.skin.box) { fontSize = 16 };
            if (cjkFont != null)
            {
                GUI.skin.font = cjkFont;
                _label.font = _title.font = _btn.font = _box.font = cjkFont;
            }
        }

        void OnGUI()
        {
            uiScale = Mathf.Max(1f, Screen.height / 700f);   // 整体 UI 放大（手机更明显）
            GUI.matrix = Matrix4x4.TRS(Vector3.zero, Quaternion.identity, new Vector3(uiScale, uiScale, 1f));
            EnsureStyles();
            guiRects.Clear();
            // 登录/连接界面已迁到 UGUI(DWUguiHud)；IMGUI 仅画游戏内摇杆/聊天
            if (state == State.Playing) GuiHud();
        }

        void GuiHud()
        {
            // 状态/技能/攻击/横幅/信息流/升级/提示/死亡/背包面板/队伍血条/小地图 均由 UGUI(DWUguiHud) 接管。
            // IMGUI 仅保留：虚拟摇杆、聊天输入。

            // 虚拟摇杆（触屏）
            if (moveTouchId >= 0)
            {
                var c = new Vector2(moveTouchStart.x / uiScale, SH - moveTouchStart.y / uiScale);
                GUI.Box(new Rect(c.x - 55, c.y - 55, 110, 110), "");
                var cur = c + new Vector2(moveTouchVec.x, -moveTouchVec.y) * 42f;
                GUI.Box(new Rect(cur.x - 20, cur.y - 20, 40, 40), "●");
            }

            if (chatOpen) GuiChat();
            else GUI.Label(new Rect(12, SH - 24, 300, 20), "<size=11><color=#888>按 T 聊天</color></size>", _label);
        }

        void GuiChat()
        {
            var r = new Rect(SW / 2f - 240, SH - 150, 480, 34);
            guiRects.Add(r);
            // 回车发送 / Esc 关闭（在控件处理前截获按键）
            var ev = Event.current;
            if (ev.type == EventType.KeyDown)
            {
                if (ev.keyCode == KeyCode.Return || ev.keyCode == KeyCode.KeypadEnter)
                {
                    var msg = chatText.Trim();
                    // 聊天命令：/邀请 名字 → 组队邀请；/退队 → 离开队伍
                    if (msg.StartsWith("/邀请 ") || msg.StartsWith("/invite "))
                        Send(new { t = "party", op = "invite", name = msg.Substring(msg.IndexOf(' ') + 1).Trim() });
                    else if (msg == "/退队" || msg == "/leave")
                        Send(new { t = "party", op = "leave" });
                    else if (msg.Length > 0) Send(new { t = "chat", msg });
                    chatText = "";
                    chatOpen = false;
                    ev.Use();
                    return;
                }
                if (ev.keyCode == KeyCode.Escape) { chatOpen = false; ev.Use(); return; }
            }
            GUI.SetNextControlName("dw_chat");
            chatText = GUI.TextField(r, chatText, 60);
            GUI.FocusControl("dw_chat");
        }

        /* 技能效果类型 → 颜色（图标按效果上色，不同职业技能类型不同→图标也不同） */
        static Color KindColor(string kind)
        {
            switch (kind)
            {
                case "proj": return new Color(0.30f, 0.80f, 1f);     // 远程=青
                case "aoe": return new Color(1f, 0.55f, 0.12f);      // 范围=橙
                case "dashmelee": return new Color(0.7f, 0.4f, 1f);  // 突进=紫
                case "heal": return new Color(0.3f, 0.95f, 0.5f);    // 治疗=绿
                case "aoeheal": return new Color(0.5f, 1f, 0.7f);    // 群疗=浅绿
                default: return new Color(1f, 0.4f, 0.35f);          // 近战=红
            }
        }

        /* 在矩形里画一个纯色图标块（带顶部高光），IMGUI 无贴图也能有"图标" */
        void IconSwatch(Rect r, Color c)
        {
            GUI.color = new Color(c.r * 0.5f, c.g * 0.5f, c.b * 0.5f, 0.9f);
            GUI.DrawTexture(r, Texture2D.whiteTexture);
            GUI.color = new Color(c.r, c.g, c.b, 0.95f);
            GUI.DrawTexture(new Rect(r.x + 2, r.y + 2, r.width - 4, r.height - 4), Texture2D.whiteTexture);
            GUI.color = new Color(1, 1, 1, 0.25f);
            GUI.DrawTexture(new Rect(r.x + 2, r.y + 2, r.width - 4, 3), Texture2D.whiteTexture);
            GUI.color = Color.white;
        }

        void GuiSkillBar()
        {
            var keys = new[] { "basic", "q", "e", "r" };
            var keyLabels = new[] { "攻击", "Q", "E", "R" };
            float slotW = 116, slotH = 98, gap = 10;   // 放大技能格（含图标）
            int extra = 2;   // 翻滚 + 次元技能
            float total = (keys.Length + extra) * (slotW + gap);
            float x0 = (SW - total) / 2, y0 = SH - slotH - 18;
            var def = Data.Cls(myCls);

            // 触屏大攻击键（右下，醒目）
            var atkR = new Rect(SW - 150, SH - 150, 110, 110);
            guiRects.Add(atkR);
            GUI.backgroundColor = new Color(1f, 0.5f, 0.3f, 0.9f);
            if (GUI.Button(atkR, "⚔\n攻击", new GUIStyle(_btn) { fontSize = 24, fontStyle = FontStyle.Bold })) Cast("basic");
            GUI.backgroundColor = Color.white;

            for (int i = 0; i < keys.Length; i++)
            {
                var sk = def.Skill(keys[i]);
                var r = new Rect(x0 + i * (slotW + gap), y0, slotW, slotH);
                guiRects.Add(r);
                bool locked = sk.minLvl > 0 && MyLevel < sk.minLvl;
                float ready;
                readyAt.TryGetValue(keys[i], out ready);
                float cdRemain = Mathf.Max(0, ready - Time.time);
                GUI.Box(r, "", _box);
                // 图标块（按技能效果类型上色）+ 按键角标
                var ic = new Rect(r.x + 6, r.y + 6, slotW - 12, 42);
                IconSwatch(ic, locked ? Color.gray : KindColor(sk.kind));
                GUI.Label(new Rect(ic.x + 4, ic.y + 2, slotW, 20), $"<b><color=#fff>{keyLabels[i]}</color></b>", _label);
                GUI.Label(new Rect(ic.x, ic.y + 2, ic.width - 6, 20), $"<color=#ffd166>Lv{MySkLvl(keys[i])}</color>", new GUIStyle(_label) { alignment = TextAnchor.UpperRight });
                GUI.Label(new Rect(r.x + 4, r.y + 50, slotW - 8, 20), locked ? $"<size=13><color=#888>{sk.name}🔒</color></size>" : $"<size=13>{sk.name}</size>", new GUIStyle(_label) { alignment = TextAnchor.MiddleCenter });
                if (cdRemain > 0)
                    GUI.Label(new Rect(r.x + 4, r.y + 72, slotW - 8, 22), $"<b><color=#fff>{cdRemain:0.0}s</color></b>", new GUIStyle(_label) { alignment = TextAnchor.MiddleCenter });
                else if (GUI.Button(new Rect(r.x + 8, r.y + 72, slotW - 16, 22), "施放", _btn)) Cast(keys[i]);
                if (MySkPts > 0 && !locked)
                {
                    var pr = new Rect(r.xMax - 26, r.y - 12, 26, 26);
                    guiRects.Add(pr);
                    GUI.backgroundColor = Data.Hex("#ffd166");
                    if (GUI.Button(pr, "+", _btn)) Send(new { t = "sklvl", k = keys[i] });
                    GUI.backgroundColor = Color.white;
                }
            }
            // 翻滚
            var dr = new Rect(x0 + keys.Length * (slotW + gap), y0, slotW, slotH);
            guiRects.Add(dr);
            GUI.Box(dr, "", _box);
            IconSwatch(new Rect(dr.x + 6, dr.y + 6, slotW - 12, 42), new Color(0.45f, 0.6f, 0.85f));
            GUI.Label(new Rect(dr.x + 10, dr.y + 8, slotW, 20), "<b><color=#fff>空格</color></b>", _label);
            GUI.Label(new Rect(dr.x + 4, dr.y + 50, slotW - 8, 20), "<size=13>翻滚闪避</size>", new GUIStyle(_label) { alignment = TextAnchor.MiddleCenter });
            float dRemain = Mathf.Max(0, dodgeReadyAt - Time.time);
            if (dRemain > 0) GUI.Label(new Rect(dr.x + 4, dr.y + 72, slotW - 8, 22), $"<b><color=#fff>{dRemain:0.0}s</color></b>", new GUIStyle(_label) { alignment = TextAnchor.MiddleCenter });
            // 次元专属技能（F 键）
            {
                var cr = new Rect(x0 + (keys.Length + 1) * (slotW + gap), y0, slotW, slotH);
                guiRects.Add(cr);
                GUI.Box(cr, "", _box);
                IconSwatch(new Rect(cr.x + 6, cr.y + 6, slotW - 12, 42), new Color(1f, 0.84f, 0.25f));
                GUI.Label(new Rect(cr.x + 10, cr.y + 8, slotW, 20), "<b><color=#fff>F 次元</color></b>", _label);
                GUI.Label(new Rect(cr.x + 4, cr.y + 50, slotW - 8, 20), $"<size=13>{dimSkillName}</size>", new GUIStyle(_label) { alignment = TextAnchor.MiddleCenter });
                float cRemain = Mathf.Max(0, captureReadyAt - Time.time);
                if (cRemain > 0) GUI.Label(new Rect(cr.x + 4, cr.y + 72, slotW - 8, 22), $"<b><color=#fff>{cRemain:0.0}s</color></b>", new GUIStyle(_label) { alignment = TextAnchor.MiddleCenter });
            }
        }

        void GuiDeath()
        {
            var r = new Rect(SW / 2f - 180, SH / 2f - 80, 360, 150);
            guiRects.Add(r);
            GUI.Box(r, "", _box);
            bool arena = curRoom == "war" || curRoom == "melee";
            GUI.Label(new Rect(r.x, r.y + 16, r.width, 32), "💀 你已阵亡", new GUIStyle(_title) { fontSize = 22 });
            if (arena)
                GUI.Label(new Rect(r.x + 10, r.y + 44, r.width - 20, 22),
                    "<color=#ff9>战场/混战中无法原地复活，只能回本次元</color>",
                    new GUIStyle(_label) { alignment = TextAnchor.MiddleCenter, fontSize = 13 });
            float remain = Mathf.Max(0, 4f - (Time.time - deadAt));
            if (remain > 0)
                GUI.Label(new Rect(r.x, r.y + 66, r.width, 26), $"复活倒计时 {remain:0.0}s", new GUIStyle(_label) { alignment = TextAnchor.MiddleCenter });
            else if (GUI.Button(new Rect(r.x + 90, r.y + 66, 180, 38), arena ? "↩ 回本次元复活" : "⚔ 立即复活", _btn))
                Send(new { t = "respawn" });
        }

        void GuiPanel()
        {
            float w = 460, h = Mathf.Min(620, SH - 120);
            var r = new Rect(SW - w - 12, 60, w, h);
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
                GUILayout.Label($"<b>{sk.name}</b> <color=#ffd166>Lv.{MySkLvl(sk.key)}</color>\n<size=12><color=#999>{sk.desc}</color></size>", _label);
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

        /* 装备图标：品质色方块 + 部位首字（IMGUI 无贴图的"图标"） */
        void ItemIcon(JObject it)
        {
            var rc = Data.RarityColors[Mathf.Clamp((int?)it["rar"] ?? 0, 0, 4)];
            string slotName; Data.SlotNames.TryGetValue((string)it["slot"] ?? "", out slotName);
            GUI.backgroundColor = rc;
            GUILayout.Box(string.IsNullOrEmpty(slotName) ? "装" : slotName.Substring(0, 1),
                new GUIStyle(_btn) { fontSize = 15, fontStyle = FontStyle.Bold }, GUILayout.Width(30), GUILayout.Height(30));
            GUI.backgroundColor = Color.white;
        }

        void GuiBag()
        {
            GUILayout.Label("<b>已装备</b>（点击卸下）", _label);
            if (equipData != null)
                foreach (var slot in Data.SlotNames)
                {
                    var it = equipData[slot.Key] as JObject;
                    if (it == null) { GUILayout.Label($"　{slot.Value}：<color=#777>空</color>", _label); continue; }
                    GUILayout.BeginHorizontal();
                    ItemIcon(it);
                    GUILayout.Label($"<color=#{RarColor(it)}>{it["name"]}</color>\n<size=12>{ItemStats(it)}</size>", _label, GUILayout.Height(30));
                    GUILayout.FlexibleSpace();
                    if (GUILayout.Button("卸下", _btn, GUILayout.Width(64), GUILayout.Height(30))) Send(new { t = "unequip", slot = slot.Key });
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
                    ItemIcon(it);
                    GUILayout.Label($"<color=#{RarColor(it)}>{it["name"]}</color>\n<size=12>{ItemStats(it)}</size>", _label, GUILayout.Height(30));
                    GUILayout.FlexibleSpace();
                    if (GUILayout.Button("装备", _btn, GUILayout.Width(58), GUILayout.Height(30))) Send(new { t = "equip", i });
                    if (GUILayout.Button($"卖{val * 2 / 5}", _btn, GUILayout.Width(64), GUILayout.Height(30))) Send(new { t = "sell", i });
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
