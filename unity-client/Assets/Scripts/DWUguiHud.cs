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
                us.icon = MkImg("Icon", slot.transform, Color.gray,
                    new Vector2(0, 1), new Vector2(1, 1), new Vector2(0.5f, 1), new Vector2(0, -10), new Vector2(sw - 20, 74));
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

            hudBuilt = true;
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

            var def = Data.Cls(myCls);
            foreach (var us in uSkills)
            {
                if (us.key == "dodge")
                {
                    us.icon.color = new Color(0.45f, 0.6f, 0.85f);
                    us.nameText.text = "翻滚闪避"; us.lvText.text = "";
                    SetCd(us, Mathf.Max(0, dodgeReadyAt - Time.time), 1.2f);
                    us.plus.SetActive(false);
                }
                else if (us.key == "dim")
                {
                    us.icon.color = new Color(1f, 0.84f, 0.25f);
                    us.nameText.text = dimSkillName; us.lvText.text = "";
                    SetCd(us, Mathf.Max(0, captureReadyAt - Time.time), dimSkillCd > 0 ? dimSkillCd : 3f);
                    us.plus.SetActive(false);
                }
                else
                {
                    var sk = def.Skill(us.key);
                    bool locked = sk.minLvl > 0 && MyLevel < sk.minLvl;
                    us.icon.color = locked ? Color.gray : KindColor(sk.kind);
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
    }
}
