/* ============================================================
 * 次元大战 Unity 客户端 - UGUI 战斗 HUD（替代 IMGUI 的核心战斗界面）
 * 真正的 Canvas + CanvasScaler（分辨率自适应、清晰）+ 可点按钮 + 填充血条 + 环形冷却
 * 阶段一：状态面板 / 血条经验条 / 技能栏(图标按钮) / 攻击键
 * 其余（背包/商店/小地图/横幅等）暂留 IMGUI，后续阶段迁移。
 * ============================================================ */
using System.Collections.Generic;
using UnityEngine;
using UnityEngine.UI;
using UnityEngine.EventSystems;

namespace DW
{
    public partial class Game
    {
        Canvas hudCanvas;
        bool hudBuilt;
        static Sprite _whiteSprite;

        Image uHpFill, uExpFill;
        Text uHpText, uStatusTop, uStatusBot;

        // 覆盖层
        GameObject uWar, uBoss, uMelee, uLevelUp, uToast, uDeath;
        Text uWarTxt, uBossTxt, uMeleeTxt, uLevelUpTxt, uToastTxt, uDeathTxt, uRespawnTxt;
        Button uWarBtn, uMeleeBtn, uRespawnBtn;
        Text uWarBtnTxt, uMeleeBtnTxt;
        Text[] uFeed;

        // 队伍小血条（左侧，状态面板下方）池化复用
        class UPartyRow { public GameObject go; public Text name; public Image hpFill; }
        readonly List<UPartyRow> uParty = new List<UPartyRow>();

        // 小地图（左下角）：RawImage + 每帧重绘的 Texture2D
        RawImage uMini;
        Texture2D uMiniTex;
        Color32[] uMiniBuf, uMiniBg;
        const int MiniN = 128;

        class USkill
        {
            public string key;          // basic/q/e/r/dodge/dim
            public Image icon, cd;
            public Text cdText, lvText, nameText;
            public GameObject plus;
        }
        readonly List<USkill> uSkills = new List<USkill>();

        static Sprite WhiteSprite()
        {
            if (_whiteSprite == null)
            {
                var t = Texture2D.whiteTexture;
                _whiteSprite = Sprite.Create(t, new Rect(0, 0, t.width, t.height), new Vector2(0.5f, 0.5f));
            }
            return _whiteSprite;
        }

        void EnsureEventSystem()
        {
            if (FindObjectOfType<EventSystem>() != null) return;
            var es = new GameObject("DW_EventSystem");
            DontDestroyOnLoad(es);
            es.AddComponent<EventSystem>();
            es.AddComponent<StandaloneInputModule>();
        }

        RectTransform MkRect(string name, Transform parent, Vector2 aMin, Vector2 aMax, Vector2 pivot, Vector2 pos, Vector2 size)
        {
            var go = new GameObject(name, typeof(RectTransform));
            go.transform.SetParent(parent, false);
            var rt = (RectTransform)go.transform;
            rt.anchorMin = aMin; rt.anchorMax = aMax; rt.pivot = pivot;
            rt.anchoredPosition = pos; rt.sizeDelta = size;
            return rt;
        }

        Image MkImg(string name, Transform parent, Color c, Vector2 aMin, Vector2 aMax, Vector2 pivot, Vector2 pos, Vector2 size)
        {
            var rt = MkRect(name, parent, aMin, aMax, pivot, pos, size);
            var img = rt.gameObject.AddComponent<Image>();
            img.sprite = WhiteSprite(); img.color = c; img.raycastTarget = false;
            return img;
        }

        Text MkTxt(string name, Transform parent, string s, int size, Color c, TextAnchor anchor, Vector2 aMin, Vector2 aMax, Vector2 pivot, Vector2 pos, Vector2 sz)
        {
            var rt = MkRect(name, parent, aMin, aMax, pivot, pos, sz);
            var t = rt.gameObject.AddComponent<Text>();
            t.text = s; t.fontSize = size; t.color = c; t.alignment = anchor;
            t.font = cjkFont != null ? cjkFont : Resources.GetBuiltinResource<Font>("LegacyRuntime.ttf");
            t.horizontalOverflow = HorizontalWrapMode.Overflow;
            t.verticalOverflow = VerticalWrapMode.Overflow;
            t.raycastTarget = false;
            var sh = t.gameObject.AddComponent<Shadow>(); sh.effectColor = new Color(0, 0, 0, 0.8f); sh.effectDistance = new Vector2(1, -1);
            return t;
        }

        Button MkBtn(string name, Transform parent, Color c, Vector2 aMin, Vector2 aMax, Vector2 pivot, Vector2 pos, Vector2 size, System.Action onClick)
        {
            var img = MkImg(name, parent, c, aMin, aMax, pivot, pos, size);
            img.raycastTarget = true;
            var b = img.gameObject.AddComponent<Button>();
            b.targetGraphic = img;
            var cb = b.colors; cb.highlightedColor = new Color(1, 1, 1, 1f); cb.pressedColor = new Color(0.8f, 0.8f, 0.8f, 1f); b.colors = cb;
            if (onClick != null) b.onClick.AddListener(() => onClick());
            return b;
        }

        void BuildHud()
        {
            EnsureEventSystem();
            var go = new GameObject("DW_HUD_Canvas");
            DontDestroyOnLoad(go);
            hudCanvas = go.AddComponent<Canvas>();
            hudCanvas.renderMode = RenderMode.ScreenSpaceOverlay;
            hudCanvas.sortingOrder = 10;
            var scaler = go.AddComponent<CanvasScaler>();
            scaler.uiScaleMode = CanvasScaler.ScaleMode.ScaleWithScreenSize;
            scaler.referenceResolution = new Vector2(1920, 1080);
            scaler.screenMatchMode = CanvasScaler.ScreenMatchMode.MatchWidthOrHeight;
            scaler.matchWidthOrHeight = 0.5f;
            go.AddComponent<GraphicRaycaster>();
            var root = go.transform;

            // ---- 左上状态面板 ----
            var panel = MkImg("Status", root, new Color(0.06f, 0.07f, 0.14f, 0.72f),
                new Vector2(0, 1), new Vector2(0, 1), new Vector2(0, 1), new Vector2(24, -24), new Vector2(560, 188));
            uStatusTop = MkTxt("Top", panel.transform, "", 26, Color.white, TextAnchor.MiddleLeft,
                new Vector2(0, 1), new Vector2(1, 1), new Vector2(0, 1), new Vector2(18, -12), new Vector2(-30, 36));
            // HP 条
            MkImg("HpBg", panel.transform, new Color(0, 0, 0, 0.6f),
                new Vector2(0, 1), new Vector2(1, 1), new Vector2(0, 1), new Vector2(18, -56), new Vector2(-36, 34));
            uHpFill = MkImg("HpFill", panel.transform, new Color(0.2f, 0.85f, 0.3f, 1f),
                new Vector2(0, 1), new Vector2(1, 1), new Vector2(0, 1), new Vector2(20, -58), new Vector2(-40, 30));
            uHpFill.type = Image.Type.Filled; uHpFill.fillMethod = Image.FillMethod.Horizontal; uHpFill.fillOrigin = 0;
            uHpText = MkTxt("HpTxt", panel.transform, "", 20, Color.white, TextAnchor.MiddleCenter,
                new Vector2(0, 1), new Vector2(1, 1), new Vector2(0.5f, 1), new Vector2(0, -56), new Vector2(-36, 34));
            // EXP 条
            MkImg("ExpBg", panel.transform, new Color(0, 0, 0, 0.6f),
                new Vector2(0, 1), new Vector2(1, 1), new Vector2(0, 1), new Vector2(18, -96), new Vector2(-36, 14));
            uExpFill = MkImg("ExpFill", panel.transform, new Color(0.62f, 0.42f, 0.86f, 1f),
                new Vector2(0, 1), new Vector2(1, 1), new Vector2(0, 1), new Vector2(20, -98), new Vector2(-40, 10));
            uExpFill.type = Image.Type.Filled; uExpFill.fillMethod = Image.FillMethod.Horizontal; uExpFill.fillOrigin = 0;
            uStatusBot = MkTxt("Bot", panel.transform, "", 22, new Color(1f, 0.9f, 0.6f), TextAnchor.MiddleLeft,
                new Vector2(0, 1), new Vector2(1, 1), new Vector2(0, 1), new Vector2(18, -118), new Vector2(-30, 34));

            // ---- 技能栏（底部居中） ----
            string[] keys = { "basic", "q", "e", "r", "dodge", "dim" };
            string[] klabel = { "攻击", "Q", "E", "R", "翻滚", "F" };
            float sw = 128, sh = 150, gap = 14;
            float totalW = keys.Length * sw + (keys.Length - 1) * gap;
            var barRoot = MkRect("SkillBar", root, new Vector2(0.5f, 0), new Vector2(0.5f, 0), new Vector2(0.5f, 0), new Vector2(0, 24), new Vector2(totalW, sh));
            for (int i = 0; i < keys.Length; i++)
            {
                float x = -totalW / 2 + i * (sw + gap);
                var slot = MkImg("Slot_" + keys[i], barRoot, new Color(0.1f, 0.11f, 0.2f, 0.8f),
                    new Vector2(0, 0), new Vector2(0, 0), new Vector2(0, 0), new Vector2(x, 0), new Vector2(sw, sh));
                var us = new USkill { key = keys[i] };
                // 图标块（颜色随后在 Refresh 设）
                us.icon = MkImg("Icon", slot.transform, Color.white,
                    new Vector2(0, 1), new Vector2(1, 1), new Vector2(0.5f, 1), new Vector2(0, -10), new Vector2(sw - 20, 74));
                us.icon.preserveAspect = true;   // 方形字形图标居中、不被拉伸
                // 环形冷却覆盖
                us.cd = MkImg("Cd", slot.transform, new Color(0, 0, 0, 0.62f),
                    new Vector2(0, 1), new Vector2(1, 1), new Vector2(0.5f, 1), new Vector2(0, -10), new Vector2(sw - 20, 74));
                us.cd.type = Image.Type.Filled; us.cd.fillMethod = Image.FillMethod.Radial360; us.cd.fillOrigin = 2; us.cd.fillAmount = 0;
                MkTxt("Key", slot.transform, $"<b>{klabel[i]}</b>", 20, Color.white, TextAnchor.UpperLeft,
                    new Vector2(0, 1), new Vector2(1, 1), new Vector2(0, 1), new Vector2(8, -6), new Vector2(sw, 26));
                us.lvText = MkTxt("Lv", slot.transform, "", 16, new Color(1f, 0.85f, 0.3f), TextAnchor.UpperRight,
                    new Vector2(0, 1), new Vector2(1, 1), new Vector2(1, 1), new Vector2(-8, -6), new Vector2(sw, 26));
                us.cdText = MkTxt("CdTxt", slot.transform, "", 26, Color.white, TextAnchor.MiddleCenter,
                    new Vector2(0, 1), new Vector2(1, 1), new Vector2(0.5f, 1), new Vector2(0, -10), new Vector2(sw, 74));
                us.nameText = MkTxt("Name", slot.transform, "", 18, Color.white, TextAnchor.MiddleCenter,
                    new Vector2(0, 0), new Vector2(1, 0), new Vector2(0.5f, 0), new Vector2(0, 8), new Vector2(sw, 30));
                // 整格可点 = 施放
                var key = keys[i];
                slot.raycastTarget = true;
                var btn = slot.gameObject.AddComponent<Button>();
                btn.targetGraphic = slot;
                btn.onClick.AddListener(() => OnSkillTap(key));
                // 加点按钮
                us.plus = MkBtn("Plus", slot.transform, new Color(1f, 0.82f, 0.25f),
                    new Vector2(1, 1), new Vector2(1, 1), new Vector2(1, 1), new Vector2(2, 8), new Vector2(34, 34),
                    () => Send(new { t = "sklvl", k = key })).gameObject;
                MkTxt("+", us.plus.transform, "+", 26, Color.black, TextAnchor.MiddleCenter,
                    Vector2.zero, Vector2.one, new Vector2(0.5f, 0.5f), Vector2.zero, Vector2.zero);
                us.plus.SetActive(false);
                uSkills.Add(us);
            }

            // ---- 大攻击键（右下） ----
            var atk = MkBtn("AttackBtn", root, new Color(0.95f, 0.45f, 0.25f, 0.95f),
                new Vector2(1, 0), new Vector2(1, 0), new Vector2(1, 0), new Vector2(-40, 60), new Vector2(170, 170),
                () => Cast("basic"));
            MkTxt("AtkTxt", atk.transform, "⚔\n攻击", 34, Color.white, TextAnchor.MiddleCenter,
                Vector2.zero, Vector2.one, new Vector2(0.5f, 0.5f), Vector2.zero, Vector2.zero);

            BuildOverlays(root);
            BuildParty(root);
            BuildMinimap(root);
            BuildPanelUI(root);
            hudBuilt = true;
        }

        // ---- 顶部横幅 / 信息流 / 升级 / 提示 / 死亡 ----
        GameObject MkBanner(Transform root, string name, Color bg, float topY, float w, out Text txt)
        {
            var p = MkImg(name, root, bg, new Vector2(0.5f, 1), new Vector2(0.5f, 1), new Vector2(0.5f, 1), new Vector2(0, topY), new Vector2(w, 44));
            txt = MkTxt("t", p.transform, "", 22, Color.white, TextAnchor.MiddleLeft,
                new Vector2(0, 0), new Vector2(1, 1), new Vector2(0, 0.5f), new Vector2(20, 0), new Vector2(-180, 0));
            p.SetActive(false);
            return p.gameObject;
        }

        void BuildOverlays(Transform root)
        {
            uWar = MkBanner(root, "WarBanner", new Color(0.27f, 0.06f, 0.12f, 0.85f), -14, 720, out uWarTxt);
            uWarBtn = MkBtn("Btn", uWar.transform, new Color(0.82f, 0.23f, 0.35f), new Vector2(1, 0.5f), new Vector2(1, 0.5f), new Vector2(1, 0.5f), new Vector2(-8, 0), new Vector2(160, 34),
                () => Send(new { t = "war", enter = curRoom == "war" ? 0 : 1 }));
            uWarBtnTxt = MkTxt("t", uWarBtn.transform, "", 20, Color.white, TextAnchor.MiddleCenter, Vector2.zero, Vector2.one, new Vector2(0.5f, 0.5f), Vector2.zero, Vector2.zero);
            uBoss = MkBanner(root, "BossBanner", new Color(0.3f, 0.05f, 0.05f, 0.85f), -64, 720, out uBossTxt);
            uMelee = MkBanner(root, "MeleeBanner", new Color(0.3f, 0.06f, 0.24f, 0.88f), -114, 720, out uMeleeTxt);
            uMeleeBtn = MkBtn("Btn", uMelee.transform, new Color(0.85f, 0.25f, 0.6f), new Vector2(1, 0.5f), new Vector2(1, 0.5f), new Vector2(1, 0.5f), new Vector2(-8, 0), new Vector2(160, 34),
                () => Send(new { t = "melee", enter = curRoom == "melee" ? 0 : 1 }));
            uMeleeBtnTxt = MkTxt("t", uMeleeBtn.transform, "", 20, Color.white, TextAnchor.MiddleCenter, Vector2.zero, Vector2.one, new Vector2(0.5f, 0.5f), Vector2.zero, Vector2.zero);

            // 信息流（右上 6 行）
            uFeed = new Text[6];
            for (int i = 0; i < 6; i++)
                uFeed[i] = MkTxt("Feed" + i, root, "", 20, Color.white, TextAnchor.UpperRight,
                    new Vector2(1, 1), new Vector2(1, 1), new Vector2(1, 1), new Vector2(-20, -150 - i * 30), new Vector2(620, 28));

            // 升级横幅（中上）
            uLevelUp = MkImg("LevelUp", root, new Color(1f, 0.6f, 0.15f, 0.92f), new Vector2(0.5f, 1), new Vector2(0.5f, 1), new Vector2(0.5f, 1), new Vector2(0, -200), new Vector2(420, 70)).gameObject;
            uLevelUpTxt = MkTxt("t", uLevelUp.transform, "", 34, Color.white, TextAnchor.MiddleCenter, Vector2.zero, Vector2.one, new Vector2(0.5f, 0.5f), Vector2.zero, Vector2.zero);
            uLevelUp.SetActive(false);

            // 顶部提示 toast（屏幕中下）
            uToast = MkImg("Toast", root, new Color(0, 0, 0, 0.7f), new Vector2(0.5f, 0), new Vector2(0.5f, 0), new Vector2(0.5f, 0), new Vector2(0, 230), new Vector2(760, 44)).gameObject;
            uToastTxt = MkTxt("t", uToast.transform, "", 22, Color.white, TextAnchor.MiddleCenter, Vector2.zero, Vector2.one, new Vector2(0.5f, 0.5f), Vector2.zero, Vector2.zero);
            uToast.SetActive(false);

            // 死亡全屏
            uDeath = MkImg("Death", root, new Color(0.4f, 0, 0, 0.45f), Vector2.zero, Vector2.one, new Vector2(0.5f, 0.5f), Vector2.zero, Vector2.zero).gameObject;
            var dbox = MkImg("box", uDeath.transform, new Color(0.08f, 0.05f, 0.08f, 0.95f), new Vector2(0.5f, 0.5f), new Vector2(0.5f, 0.5f), new Vector2(0.5f, 0.5f), Vector2.zero, new Vector2(520, 240));
            MkTxt("t", dbox.transform, "💀 你已阵亡", 40, new Color(1f, 0.5f, 0.5f), TextAnchor.UpperCenter, new Vector2(0, 1), new Vector2(1, 1), new Vector2(0.5f, 1), new Vector2(0, -28), new Vector2(-20, 50));
            uDeathTxt = MkTxt("cd", dbox.transform, "", 24, Color.white, TextAnchor.MiddleCenter, new Vector2(0, 1), new Vector2(1, 1), new Vector2(0.5f, 1), new Vector2(0, -100), new Vector2(-20, 40));
            uRespawnBtn = MkBtn("rb", dbox.transform, new Color(0.3f, 0.4f, 0.85f), new Vector2(0.5f, 0), new Vector2(0.5f, 0), new Vector2(0.5f, 0), new Vector2(0, 36), new Vector2(280, 64), () => Send(new { t = "respawn" }));
            uRespawnTxt = MkTxt("t", uRespawnBtn.transform, "复活", 26, Color.white, TextAnchor.MiddleCenter, Vector2.zero, Vector2.one, new Vector2(0.5f, 0.5f), Vector2.zero, Vector2.zero);
            uDeath.SetActive(false);
        }

        void RefreshOverlays()
        {
            // 战场横幅
            bool warOn = warInfo != null && (bool?)warInfo["active"] == true;
            uWar.SetActive(warOn);
            if (warOn)
            {
                string a = (string)warInfo["a"], b = (string)warInfo["b"];
                uWarTxt.text = $"🌀 {Data.Dim(a).name} {warInfo["killsA"]} : {warInfo["killsB"]} {Data.Dim(b).name}";
                bool mine = myDim == a || myDim == b;
                uWarBtn.gameObject.SetActive(mine);
                uWarBtnTxt.text = curRoom == "war" ? "↩ 撤离" : "⚔ 进入";
            }
            // BOSS 横幅
            bool bossOn = bossInfo != null;
            uBoss.SetActive(bossOn);
            if (bossOn)
            {
                string bd = (string)bossInfo["dim"];
                uBossTxt.text = bd == myDim ? $"🔥 世界BOSS【{bossInfo["name"]}】就在本次元巢穴！" : $"🔥 世界BOSS【{bossInfo["name"]}】肆虐【{Data.Dim(bd).name}】";
            }
            // 大混战横幅
            bool meleeOn = meleeInfo != null && (bool?)meleeInfo["active"] == true;
            uMelee.SetActive(meleeOn);
            if (meleeOn) uMeleeBtnTxt.text = curRoom == "melee" ? "↩ 撤离" : "⚔ 杀入";

            // 信息流
            for (int i = 0; i < uFeed.Length; i++)
            {
                if (i < feed.Count && Time.time - feedAt[i] < 12f) uFeed[i].text = feed[i];
                else uFeed[i].text = "";
            }

            // 升级
            bool lu = Time.time < levelUpUntil;
            uLevelUp.SetActive(lu);
            if (lu) uLevelUpTxt.text = $"🆙 升级！Lv.{levelUpLevel}" + (levelUpLevel == 3 ? "  E解锁" : levelUpLevel == 5 ? "  R解锁" : "");

            // toast
            bool t = Time.time < toastUntil;
            uToast.SetActive(t);
            if (t) uToastTxt.text = toastMsg;

            // 死亡
            uDeath.SetActive(meDead);
            if (meDead)
            {
                float remain = Mathf.Max(0, 4f - (Time.time - deadAt));
                bool arena = curRoom == "war" || curRoom == "melee";
                uDeathTxt.text = arena ? "战场/混战中无法原地复活，回本次元复活" : (remain > 0 ? $"复活倒计时 {remain:0.0}s" : "可以复活了");
                uRespawnBtn.interactable = remain <= 0;
                uRespawnTxt.text = arena ? "↩ 回本次元复活" : "⚔ 立即复活";
            }
        }

        void OnSkillTap(string key)
        {
            if (key == "dodge") DoDodge();
            else if (key == "dim") { if (Time.time > captureReadyAt) { captureReadyAt = Time.time + (dimSkillCd > 0 ? dimSkillCd : 3f); Send(new { t = "dimskill" }); } }
            else Cast(key);
        }

        void RefreshHud()
        {
            if (!hudBuilt) return;
            bool playing = state == State.Playing;
            if (hudCanvas.enabled != playing) hudCanvas.enabled = playing;
            if (!playing) return;

            int hp = you != null ? (int?)you["hp"] ?? 0 : 0;
            int maxHp = you != null ? (int?)you["maxHp"] ?? 1 : 1;
            int shield = you != null ? (int?)you["shield"] ?? 0 : 0;
            int exp = you != null ? (int?)you["exp"] ?? 0 : 0;
            int expNeed = you != null ? (int?)you["expNeed"] ?? 1 : 1;
            int gold = you != null ? (int?)you["gold"] ?? 0 : 0;
            var roomName = curRoom == "war" ? "🌀 重叠战场" : curRoom == "melee" ? "🔥 大混战" : Data.Dim(myDim).name;
            uStatusTop.text = $"{roomName} ｜ {Data.ClassTitle(myDim, myCls)}";
            uHpFill.fillAmount = Mathf.Clamp01((float)hp / maxHp);
            uHpText.text = shield > 0 ? $"{hp}/{maxHp}  🛡{shield}" : $"{hp}/{maxHp}";
            uExpFill.fillAmount = Mathf.Clamp01((float)exp / expNeed);
            uStatusBot.text = $"Lv.{MyLevel} ｜ 💰{gold}" + (MySkPts > 0 ? $"  ✨×{MySkPts}" : "");

            RefreshOverlays();
            RefreshParty();
            RefreshMinimap();
            RefreshPanel();

            var def = Data.Cls(myCls);
            foreach (var us in uSkills)
            {
                if (us.key == "dodge")
                {
                    us.icon.sprite = KindIcon("dodge"); us.icon.color = Color.white;
                    us.nameText.text = "翻滚闪避"; us.lvText.text = "";
                    SetCd(us, Mathf.Max(0, dodgeReadyAt - Time.time), 1.2f);
                    us.plus.SetActive(false);
                }
                else if (us.key == "dim")
                {
                    us.icon.sprite = KindIcon("dim"); us.icon.color = Color.white;
                    us.nameText.text = dimSkillName; us.lvText.text = "";
                    SetCd(us, Mathf.Max(0, captureReadyAt - Time.time), dimSkillCd > 0 ? dimSkillCd : 3f);
                    us.plus.SetActive(false);
                }
                else
                {
                    var sk = def.Skill(us.key);
                    bool locked = sk.minLvl > 0 && MyLevel < sk.minLvl;
                    us.icon.sprite = KindIcon(sk.kind);
                    us.icon.color = locked ? new Color(0.5f, 0.5f, 0.5f, 1f) : Color.white;   // 未解锁→压暗
                    us.nameText.text = locked ? sk.name + "🔒" : sk.name;
                    us.lvText.text = "Lv" + MySkLvl(us.key);
                    float ready; readyAt.TryGetValue(us.key, out ready);
                    SetCd(us, Mathf.Max(0, ready - Time.time), Mathf.Max(0.1f, sk.cdMs / 1000f));
                    us.plus.SetActive(MySkPts > 0 && !locked);
                }
            }
        }

        void SetCd(USkill us, float remain, float total)
        {
            float f = total > 0 ? Mathf.Clamp01(remain / total) : 0;
            us.cd.fillAmount = f;
            us.cdText.text = remain > 0.05f ? remain.ToString("0.0") : "";
        }

        // ====================== 程序化技能图标（按效果类型画出可辨识图形，替代纯色块） ======================
        readonly Dictionary<string, Sprite> _kindIcons = new Dictionary<string, Sprite>();

        static Color IconBg(string kind)
        {
            switch (kind)
            {
                case "dodge": return new Color(0.30f, 0.52f, 0.88f);   // 翻滚=蓝
                case "dim": return new Color(1f, 0.78f, 0.22f);        // 次元技=金
                default: return KindColor(kind);
            }
        }

        Sprite KindIcon(string kind)
        {
            if (_kindIcons.TryGetValue(kind, out var cached)) return cached;
            const int N = 72;
            var buf = new Color32[N * N];
            Color bg = IconBg(kind);
            Color bgDark = new Color(bg.r * 0.42f, bg.g * 0.42f, bg.b * 0.48f, 1f);
            float feather = 2.4f / N;
            for (int y = 0; y < N; y++)
                for (int x = 0; x < N; x++)
                {
                    float u = (x + 0.5f) / N * 2f - 1f;
                    float v = (y + 0.5f) / N * 2f - 1f;
                    var p = new Vector2(u, v);
                    // 背景：四角略暗的渐变，像有体积的图标块
                    float edge = Mathf.Clamp01(1f - 0.5f * Mathf.Max(Mathf.Abs(u), Mathf.Abs(v)));
                    Color baseCol = Color.Lerp(bgDark, bg, edge);
                    float d = GlyphSdf(kind, p);
                    float cov = Mathf.Clamp01(0.5f - d / feather);
                    buf[y * N + x] = Color.Lerp(baseCol, Color.white, cov);
                }
            var tex = new Texture2D(N, N, TextureFormat.RGBA32, false) { filterMode = FilterMode.Bilinear, wrapMode = TextureWrapMode.Clamp };
            tex.SetPixels32(buf); tex.Apply(false);
            var sp = Sprite.Create(tex, new Rect(0, 0, N, N), new Vector2(0.5f, 0.5f), 100f);
            _kindIcons[kind] = sp;
            return sp;
        }

        // 各效果类型的白色字形（SDF，归一化坐标 [-1,1]，负值=图形内部）
        static float GlyphSdf(string kind, Vector2 p)
        {
            switch (kind)
            {
                case "proj":   // 远程→箭头
                    return Mathf.Min(
                        SdSeg(p, new Vector2(-0.6f, 0), new Vector2(0.15f, 0), 0.12f),
                        SdTri(p, new Vector2(0.62f, 0), new Vector2(0.08f, 0.36f), new Vector2(0.08f, -0.36f)));
                case "aoe":    // 范围→爆裂圆环+核心
                    return Mathf.Min(Mathf.Abs(SdCircle(p, 0.52f)) - 0.14f, SdCircle(p, 0.13f));
                case "dashmelee":  // 突进→右向双折线
                    return Mathf.Min(Chevron(p + new Vector2(0.26f, 0)), Chevron(p - new Vector2(0.14f, 0)));
                case "heal":   // 治疗→十字
                    return Mathf.Min(SdBox(p, new Vector2(0.16f, 0.5f)), SdBox(p, new Vector2(0.5f, 0.16f)));
                case "aoeheal":  // 群疗→十字+圆环
                    return Mathf.Min(
                        Mathf.Min(SdBox(p, new Vector2(0.12f, 0.34f)), SdBox(p, new Vector2(0.34f, 0.12f))),
                        Mathf.Abs(SdCircle(p, 0.72f)) - 0.09f);
                case "dodge":  // 翻滚→上向双折线（位移感）
                    return Mathf.Min(ChevronUp(p + new Vector2(0, 0.22f)), ChevronUp(p - new Vector2(0, 0.18f)));
                case "dim":    // 次元技→八角星 sparkle
                {
                    float plus = Mathf.Min(SdBox(p, new Vector2(0.1f, 0.56f)), SdBox(p, new Vector2(0.56f, 0.1f)));
                    Vector2 r = Rot45(p);
                    float x = Mathf.Min(SdBox(r, new Vector2(0.08f, 0.4f)), SdBox(r, new Vector2(0.4f, 0.08f)));
                    return Mathf.Min(plus, x);
                }
                default:       // 近战→双斜斩
                    return Mathf.Min(
                        SdSeg(p, new Vector2(-0.5f, -0.32f), new Vector2(0.34f, 0.52f), 0.1f),
                        SdSeg(p, new Vector2(-0.28f, -0.52f), new Vector2(0.52f, 0.3f), 0.1f));
            }
        }

        static float Chevron(Vector2 p)   // ">" 尖朝右
        {
            return Mathf.Min(
                SdSeg(p, new Vector2(-0.22f, 0.4f), new Vector2(0.22f, 0), 0.11f),
                SdSeg(p, new Vector2(0.22f, 0), new Vector2(-0.22f, -0.4f), 0.11f));
        }
        static float ChevronUp(Vector2 p) // "^" 尖朝上
        {
            return Mathf.Min(
                SdSeg(p, new Vector2(-0.36f, -0.12f), new Vector2(0, 0.26f), 0.11f),
                SdSeg(p, new Vector2(0, 0.26f), new Vector2(0.36f, -0.12f), 0.11f));
        }
        static Vector2 Rot45(Vector2 p)
        {
            const float c = 0.70710678f;
            return new Vector2(p.x * c - p.y * c, p.x * c + p.y * c);
        }
        static float SdCircle(Vector2 p, float r) => p.magnitude - r;
        static float SdBox(Vector2 p, Vector2 b)
        {
            float dx = Mathf.Abs(p.x) - b.x, dy = Mathf.Abs(p.y) - b.y;
            return new Vector2(Mathf.Max(dx, 0), Mathf.Max(dy, 0)).magnitude + Mathf.Min(Mathf.Max(dx, dy), 0);
        }
        static float SdSeg(Vector2 p, Vector2 a, Vector2 b, float th)
        {
            Vector2 pa = p - a, ba = b - a;
            float h = Mathf.Clamp01(Vector2.Dot(pa, ba) / Vector2.Dot(ba, ba));
            return (pa - ba * h).magnitude - th;
        }
        static float SdTri(Vector2 p, Vector2 p0, Vector2 p1, Vector2 p2)
        {
            Vector2 e0 = p1 - p0, e1 = p2 - p1, e2 = p0 - p2;
            Vector2 v0 = p - p0, v1 = p - p1, v2 = p - p2;
            Vector2 pq0 = v0 - e0 * Mathf.Clamp01(Vector2.Dot(v0, e0) / Vector2.Dot(e0, e0));
            Vector2 pq1 = v1 - e1 * Mathf.Clamp01(Vector2.Dot(v1, e1) / Vector2.Dot(e1, e1));
            Vector2 pq2 = v2 - e2 * Mathf.Clamp01(Vector2.Dot(v2, e2) / Vector2.Dot(e2, e2));
            float s = Mathf.Sign(e0.x * e2.y - e0.y * e2.x);
            Vector2 d = Vector2.Min(Vector2.Min(
                new Vector2(Vector2.Dot(pq0, pq0), s * (v0.x * e0.y - v0.y * e0.x)),
                new Vector2(Vector2.Dot(pq1, pq1), s * (v1.x * e1.y - v1.y * e1.x))),
                new Vector2(Vector2.Dot(pq2, pq2), s * (v2.x * e2.y - v2.y * e2.x)));
            return -Mathf.Sqrt(d.x) * Mathf.Sign(d.y);
        }

        // ====================== 队伍小血条（左侧） ======================
        void BuildParty(Transform root)
        {
            // 状态面板高 188、距顶 24，故从 ~ -228 起向下排
            const int maxRows = 5;
            for (int i = 0; i < maxRows; i++)
            {
                var box = MkImg("Party" + i, root, new Color(0.06f, 0.07f, 0.14f, 0.7f),
                    new Vector2(0, 1), new Vector2(0, 1), new Vector2(0, 1), new Vector2(24, -228 - i * 56), new Vector2(300, 50));
                var name = MkTxt("n", box.transform, "", 18, Color.white, TextAnchor.UpperLeft,
                    new Vector2(0, 1), new Vector2(1, 1), new Vector2(0, 1), new Vector2(10, -4), new Vector2(-16, 24));
                MkImg("bg", box.transform, new Color(0, 0, 0, 0.6f),
                    new Vector2(0, 0), new Vector2(1, 0), new Vector2(0, 0), new Vector2(10, 8), new Vector2(-20, 12));
                var fill = MkImg("fill", box.transform, new Color(0.2f, 0.85f, 0.3f, 1f),
                    new Vector2(0, 0), new Vector2(1, 0), new Vector2(0, 0), new Vector2(11, 9), new Vector2(-22, 10));
                fill.type = Image.Type.Filled; fill.fillMethod = Image.FillMethod.Horizontal; fill.fillOrigin = 0;
                box.gameObject.SetActive(false);
                uParty.Add(new UPartyRow { go = box.gameObject, name = name, hpFill = fill });
            }
        }

        void RefreshParty()
        {
            int n = partyMembers != null ? partyMembers.Count : 0;
            for (int i = 0; i < uParty.Count; i++)
            {
                bool on = i < n;
                if (uParty[i].go.activeSelf != on) uParty[i].go.SetActive(on);
                if (!on) continue;
                var m = (JObject)partyMembers[i];
                int hp = (int?)m["hp"] ?? 0, max = (int?)m["maxHp"] ?? 1;
                uParty[i].name.text = $"👤 {m["name"]} Lv.{m["level"]}";
                uParty[i].hpFill.fillAmount = Mathf.Clamp01((float)hp / Mathf.Max(1, max));
            }
        }

        // ====================== 小地图（左下角） ======================
        void BuildMinimap(Transform root)
        {
            // 边框 + 画布（左下角，避开底部技能栏与右下攻击键）
            var frame = MkImg("MiniFrame", root, new Color(0.5f, 0.55f, 0.7f, 0.5f),
                new Vector2(0, 0), new Vector2(0, 0), new Vector2(0, 0), new Vector2(20, 20), new Vector2(228, 228));
            var go = new GameObject("Minimap", typeof(RectTransform));
            go.transform.SetParent(frame.transform, false);
            var rt = (RectTransform)go.transform;
            rt.anchorMin = Vector2.zero; rt.anchorMax = Vector2.one; rt.pivot = new Vector2(0.5f, 0.5f);
            rt.offsetMin = new Vector2(3, 3); rt.offsetMax = new Vector2(-3, -3);
            uMini = go.AddComponent<RawImage>();
            uMini.raycastTarget = false;
            uMiniTex = new Texture2D(MiniN, MiniN, TextureFormat.RGBA32, false) { filterMode = FilterMode.Point, wrapMode = TextureWrapMode.Clamp };
            uMini.texture = uMiniTex;
            uMiniBuf = new Color32[MiniN * MiniN];
            uMiniBg = new Color32[MiniN * MiniN];
            var bg = new Color32(8, 11, 24, 168);
            for (int i = 0; i < uMiniBg.Length; i++) uMiniBg[i] = bg;
        }

        void MiniDot(int cx, int cy, int rad, Color32 c)
        {
            int x0 = Mathf.Max(0, cx - rad), x1 = Mathf.Min(MiniN - 1, cx + rad);
            int y0 = Mathf.Max(0, cy - rad), y1 = Mathf.Min(MiniN - 1, cy + rad);
            for (int y = y0; y <= y1; y++)
                for (int x = x0; x <= x1; x++)
                    uMiniBuf[y * MiniN + x] = c;
        }

        // 世界坐标(x,z) → 小地图像素（z 向上为北）
        void MiniPx(float x, float z, out int px, out int py)
        {
            float half = Data.MapHalf, span = half * 2f;
            px = Mathf.Clamp(Mathf.RoundToInt((x + half) / span * (MiniN - 1)), 0, MiniN - 1);
            py = Mathf.Clamp(Mathf.RoundToInt((z + half) / span * (MiniN - 1)), 0, MiniN - 1);
        }

        void RefreshMinimap()
        {
            if (uMiniTex == null) return;
            System.Array.Copy(uMiniBg, uMiniBuf, uMiniBuf.Length);
            int px, py;
            // 障碍
            foreach (var o in obstacles) { MiniPx(o.x, o.y, out px, out py); MiniDot(px, py, 0, new Color32(150, 163, 191, 128)); }
            // 安全区中心
            MiniPx(0, 0, out px, out py); MiniDot(px, py, 2, new Color32(102, 217, 128, 200));
            // BOSS 巢穴方向
            if (curRoom != "war" && curRoom != "melee")
            {
                float la = Data.LairAngle(myDim);
                MiniPx(Mathf.Cos(la) * Data.LairR, Mathf.Sin(la) * Data.LairR, out px, out py);
                MiniDot(px, py, 3, new Color32(255, 77, 69, 230));
            }
            // 怪物 / BOSS
            foreach (var e in monsters.Values)
            {
                if (e.dead || e.go == null) continue;
                var p = e.go.transform.position; MiniPx(p.x, p.z, out px, out py);
                if (e.tier >= 5) MiniDot(px, py, 3, new Color32(255, 33, 69, 255));
                else MiniDot(px, py, 1, new Color32(255, 120, 69, 255));
            }
            // 其他玩家
            foreach (var e in players.Values)
            {
                if (e.go == null) continue;
                var p = e.go.transform.position; MiniPx(p.x, p.z, out px, out py);
                MiniDot(px, py, 2, e.dim == myDim ? new Color32(92, 240, 122, 255) : new Color32(255, 171, 51, 255));
            }
            // 自己（白）
            MiniPx(pos.x, pos.z, out px, out py); MiniDot(px, py, 2, new Color32(255, 255, 255, 255));
            uMiniTex.SetPixels32(uMiniBuf);
            uMiniTex.Apply(false);
        }

        // ====================== 背包/商店/属性 面板 ======================
        GameObject uPanel;
        RectTransform uPanelContent;
        Text[] uTabTxt;
        string uPanelSig = "";

        void BuildPanelUI(Transform root)
        {
            // 右上 🎒 开关
            var bag = MkBtn("BagBtn", root, new Color(0.18f, 0.2f, 0.36f, 0.95f),
                new Vector2(1, 1), new Vector2(1, 1), new Vector2(1, 1), new Vector2(-24, -24), new Vector2(76, 76),
                () => panelOpen = !panelOpen);
            MkTxt("t", bag.transform, "🎒", 34, Color.white, TextAnchor.MiddleCenter, Vector2.zero, Vector2.one, new Vector2(0.5f, 0.5f), Vector2.zero, Vector2.zero);
            // 退出
            var exit = MkBtn("ExitBtn", root, new Color(0.36f, 0.18f, 0.2f, 0.95f),
                new Vector2(1, 1), new Vector2(1, 1), new Vector2(1, 1), new Vector2(-110, -24), new Vector2(76, 76),
                () => ExitToMenu());
            MkTxt("t", exit.transform, "🚪", 34, Color.white, TextAnchor.MiddleCenter, Vector2.zero, Vector2.one, new Vector2(0.5f, 0.5f), Vector2.zero, Vector2.zero);

            // 面板
            uPanel = MkImg("Panel", root, new Color(0.07f, 0.08f, 0.16f, 0.97f),
                new Vector2(1, 1), new Vector2(1, 1), new Vector2(1, 1), new Vector2(-24, -112), new Vector2(680, 760)).gameObject;
            // 顶部标签
            string[] tabs = { "📊 属性", "🎒 背包", "🛒 商店" };
            uTabTxt = new Text[tabs.Length];
            float tw = 680f / (tabs.Length + 1);
            for (int i = 0; i < tabs.Length; i++)
            {
                int idx = i;
                var tb = MkBtn("Tab" + i, uPanel.transform, new Color(0.12f, 0.13f, 0.24f, 1f),
                    new Vector2(0, 1), new Vector2(0, 1), new Vector2(0, 1), new Vector2(i * tw, 0), new Vector2(tw, 56),
                    () => { panelTab = idx; uPanelSig = ""; });
                uTabTxt[i] = MkTxt("t", tb.transform, tabs[i], 22, Color.white, TextAnchor.MiddleCenter, Vector2.zero, Vector2.one, new Vector2(0.5f, 0.5f), Vector2.zero, Vector2.zero);
            }
            var close = MkBtn("Close", uPanel.transform, new Color(0.3f, 0.12f, 0.14f, 1f),
                new Vector2(1, 1), new Vector2(1, 1), new Vector2(1, 1), new Vector2(0, 0), new Vector2(tw, 56), () => panelOpen = false);
            MkTxt("t", close.transform, "✕", 24, Color.white, TextAnchor.MiddleCenter, Vector2.zero, Vector2.one, new Vector2(0.5f, 0.5f), Vector2.zero, Vector2.zero);

            // 滚动列表
            var sr = MkRect("Scroll", uPanel.transform, new Vector2(0, 0), new Vector2(1, 1), new Vector2(0.5f, 0.5f), new Vector2(0, -28), new Vector2(-16, -72));
            var srImg = sr.gameObject.AddComponent<Image>(); srImg.color = new Color(0, 0, 0, 0.15f); srImg.sprite = WhiteSprite();
            var scroll = sr.gameObject.AddComponent<ScrollRect>();
            scroll.horizontal = false; scroll.vertical = true; scroll.scrollSensitivity = 24;
            var vp = MkRect("Viewport", sr, Vector2.zero, Vector2.one, new Vector2(0, 1), Vector2.zero, Vector2.zero);
            var vpImg = vp.gameObject.AddComponent<Image>(); vpImg.color = new Color(1, 1, 1, 0.01f); vpImg.sprite = WhiteSprite();
            vp.gameObject.AddComponent<Mask>().showMaskGraphic = false;
            scroll.viewport = vp;
            uPanelContent = MkRect("Content", vp, new Vector2(0, 1), new Vector2(1, 1), new Vector2(0.5f, 1), Vector2.zero, new Vector2(0, 0));
            var vlg = uPanelContent.gameObject.AddComponent<VerticalLayoutGroup>();
            vlg.spacing = 6; vlg.padding = new RectOffset(10, 10, 10, 10);
            vlg.childControlWidth = true; vlg.childControlHeight = true; vlg.childForceExpandWidth = true; vlg.childForceExpandHeight = false;
            var csf = uPanelContent.gameObject.AddComponent<ContentSizeFitter>();
            csf.verticalFit = ContentSizeFitter.FitMode.PreferredSize;
            scroll.content = uPanelContent;

            uPanel.SetActive(false);
        }

        RectTransform AddRow(float h)
        {
            var go = new GameObject("row", typeof(RectTransform));
            go.transform.SetParent(uPanelContent, false);
            var le = go.AddComponent<LayoutElement>(); le.minHeight = h; le.preferredHeight = h;
            var bg = go.AddComponent<Image>(); bg.sprite = WhiteSprite(); bg.color = new Color(1, 1, 1, 0.05f); bg.raycastTarget = false;
            var hl = go.AddComponent<HorizontalLayoutGroup>();
            hl.spacing = 8; hl.childAlignment = TextAnchor.MiddleLeft; hl.padding = new RectOffset(8, 8, 2, 2);
            hl.childControlWidth = true; hl.childControlHeight = true; hl.childForceExpandWidth = false; hl.childForceExpandHeight = true;
            return (RectTransform)go.transform;
        }

        void RowIcon(Transform row, Color c, string label)
        {
            var go = new GameObject("ic", typeof(RectTransform));
            go.transform.SetParent(row, false);
            var le = go.AddComponent<LayoutElement>(); le.minWidth = 38; le.preferredWidth = 38;
            var img = go.AddComponent<Image>(); img.sprite = WhiteSprite(); img.color = c; img.raycastTarget = false;
            var t = MkTxt("t", go.transform, label, 16, Color.white, TextAnchor.MiddleCenter, Vector2.zero, Vector2.one, new Vector2(0.5f, 0.5f), Vector2.zero, Vector2.zero);
        }

        void RowLabel(Transform row, string s)
        {
            var go = new GameObject("lbl", typeof(RectTransform));
            go.transform.SetParent(row, false);
            var le = go.AddComponent<LayoutElement>(); le.flexibleWidth = 1;
            var t = go.AddComponent<Text>();
            t.text = s; t.fontSize = 18; t.color = Color.white; t.alignment = TextAnchor.MiddleLeft;
            t.font = cjkFont; t.horizontalOverflow = HorizontalWrapMode.Wrap; t.verticalOverflow = VerticalWrapMode.Overflow; t.raycastTarget = false;
        }

        void RowBtn(Transform row, string s, Color c, System.Action onClick)
        {
            var img = MkImg("b", row, c, Vector2.zero, Vector2.one, new Vector2(0.5f, 0.5f), Vector2.zero, Vector2.zero);
            img.raycastTarget = true;
            var le = img.gameObject.AddComponent<LayoutElement>(); le.minWidth = 80; le.preferredWidth = 80;
            var b = img.gameObject.AddComponent<Button>(); b.targetGraphic = img; b.onClick.AddListener(() => onClick());
            MkTxt("t", img.transform, s, 18, Color.white, TextAnchor.MiddleCenter, Vector2.zero, Vector2.one, new Vector2(0.5f, 0.5f), Vector2.zero, Vector2.zero);
        }

        string PanelSig()
        {
            int inv = invData != null ? invData.Count : 0;
            int gold = you != null ? (int?)you["gold"] ?? 0 : 0;
            int lv = MyLevel;
            return $"{panelTab}|{inv}|{gold}|{lv}|{(equipData != null ? equipData.ToString().Length : 0)}";
        }

        void RefreshPanel()
        {
            if (uPanel == null) return;
            uPanel.SetActive(panelOpen);
            for (int i = 0; i < uTabTxt.Length; i++)
                uTabTxt[i].color = (i == panelTab) ? new Color(1f, 0.84f, 0.3f) : new Color(0.7f, 0.72f, 0.85f);
            if (!panelOpen) return;
            var sig = PanelSig();
            if (sig == uPanelSig) return;   // 数据没变不重建
            uPanelSig = sig;
            RepopulatePanel();
        }

        void RepopulatePanel()
        {
            for (int i = uPanelContent.childCount - 1; i >= 0; i--) Destroy(uPanelContent.GetChild(i).gameObject);
            if (panelTab == 0) PanelStats();
            else if (panelTab == 1) PanelBag();
            else PanelShop();
        }

        void PanelStats()
        {
            if (you == null) { var r = AddRow(40); RowLabel(r.transform, "加载中…"); return; }
            var def = Data.Cls(myCls);
            void Line(string s) { var r = AddRow(34); RowLabel(r.transform, s); }
            Line($"<b>{def.icon} {Data.ClassTitle(myDim, myCls)}</b>（{def.role}）");
            Line($"📈 等级 Lv.{you["level"]}（{you["exp"]}/{you["expNeed"]}）");
            Line($"❤ 生命：{you["hp"]}/{you["maxHp"]}");
            Line($"⚔ 物攻 {you["patk"]}    🔮 法攻 {you["matk"]}");
            Line($"🛡 物防 {you["armor"]}    ✨ 法防 {you["mres"]}");
            Line($"👟 移速 {you["spd"]}    💰 金币 {you["gold"]}");
            Line($"🗡 击杀 野怪{you["kills"]} / 玩家{you["pvpKills"]}");
            Line($"✨ 技能点：{MySkPts}");
            Line("<b>技能</b>");
            foreach (var sk in def.skills) Line($"<color=#ffd166>{sk.name}</color> Lv.{MySkLvl(sk.key)}\n<size=13><color=#999>{sk.desc}</color></size>");
        }

        Color RarCol(JObject it) => Data.RarityColors[Mathf.Clamp((int?)it["rar"] ?? 0, 0, 4)];
        string ItemLine(JObject it)
        {
            string st = "";
            foreach (var k in new[] { "patk", "matk", "armor", "mres", "hp", "spd" })
                if (it[k] != null) st += $"{(k == "patk" ? "物攻" : k == "matk" ? "法攻" : k == "armor" ? "物防" : k == "mres" ? "法防" : k == "hp" ? "生命" : "移速")}+{it[k]} ";
            return $"<color=#{ColorUtility.ToHtmlStringRGB(RarCol(it))}>{it["name"]}</color>\n<size=13>{st}</size>";
        }

        void PanelBag()
        {
            var hr = AddRow(30); RowLabel(hr.transform, "<b>已装备</b>");
            if (equipData != null)
                foreach (var slot in Data.SlotNames)
                {
                    var it = equipData[slot.Key] as JObject;
                    var r = AddRow(46);
                    if (it == null) { RowIcon(r.transform, new Color(0.3f, 0.3f, 0.35f), slot.Value.Substring(0, 1)); RowLabel(r.transform, $"{slot.Value}：<color=#777>空</color>"); }
                    else { RowIcon(r.transform, RarCol(it), slot.Value.Substring(0, 1)); RowLabel(r.transform, ItemLine(it)); var sk = slot.Key; RowBtn(r.transform, "卸下", new Color(0.4f, 0.3f, 0.12f), () => Send(new { t = "unequip", slot = sk })); }
                }
            var br = AddRow(30); RowLabel(br.transform, $"<b>背包</b>（{(invData != null ? invData.Count : 0)}/24）");
            if (invData != null)
                for (int i = 0; i < invData.Count; i++)
                {
                    var it = (JObject)invData[i]; int idx = i; int val = (int?)it["val"] ?? 0;
                    string slotName; Data.SlotNames.TryGetValue((string)it["slot"] ?? "", out slotName);
                    var r = AddRow(46);
                    RowIcon(r.transform, RarCol(it), string.IsNullOrEmpty(slotName) ? "装" : slotName.Substring(0, 1));
                    RowLabel(r.transform, ItemLine(it));
                    RowBtn(r.transform, "装备", new Color(0.16f, 0.3f, 0.45f), () => Send(new { t = "equip", i = idx }));
                    RowBtn(r.transform, $"卖{val * 2 / 5}", new Color(0.3f, 0.2f, 0.12f), () => Send(new { t = "sell", i = idx }));
                }
        }

        void PanelShop()
        {
            int gold = you != null ? (int?)you["gold"] ?? 0 : 0;
            var hr = AddRow(30); RowLabel(hr.transform, $"<b>商店</b>（💰{gold}）");
            if (shopData == null) return;
            foreach (JObject it in shopData)
            {
                string slotName; Data.SlotNames.TryGetValue((string)it["slot"] ?? "", out slotName);
                var r = AddRow(46);
                RowIcon(r.transform, RarCol(it), string.IsNullOrEmpty(slotName) ? "装" : slotName.Substring(0, 1));
                RowLabel(r.transform, ItemLine(it));
                var id = (string)it["id"];
                RowBtn(r.transform, $"💰{it["price"]}", new Color(0.32f, 0.28f, 0.12f), () => Send(new { t = "buy", id = id }));
            }
        }
    }
}
