/* ============================================================
 * 次元大战 Unity 客户端 - UGUI 战斗 HUD（替代 IMGUI 的核心战斗界面）
 * 真正的 Canvas + CanvasScaler（分辨率自适应、清晰）+ 可点按钮 + 填充血条 + 环形冷却
 * 阶段一：状态面板 / 血条经验条 / 技能栏(图标按钮) / 攻击键
 * 其余（背包/商店/小地图/横幅等）暂留 IMGUI，后续阶段迁移。
 * ============================================================ */
using System.Collections.Generic;
using Newtonsoft.Json.Linq;
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

        // 头顶名牌 / 飘字所在的世界画布（屏幕空间，在 3D 之上、HUD 之下）
        Canvas plateCanvas;
        RectTransform plateRoot;

        // 登录/连接界面（UGUI，替代 IMGUI GuiMenu）
        Canvas menuCanvas;
        GameObject menuForm, menuConnecting;
        InputField uName;
        Button[] uDimBtns, uClsBtns;
        Text[] uClsTxt;
        Button uJoinBtn;
        Text uHunterHint, uConnTxt, uMenuToast;
        Image menuGlow;   // 登录背景光晕（随所选次元变色）

        class USkill
        {
            public string key;          // basic/q/e/r/dodge/dim
            public Image icon, cd, flash;
            public Text cdText, lvText, nameText;
            public GameObject plus;
            public bool wasReady = true;   // 冷却好了那一刻闪一下
        }
        readonly List<USkill> uSkills = new List<USkill>();

        // 按次元换肤：登记需要随玩家次元变色的描边，myDim 变化时统一刷成该次元主色
        readonly List<Image> dimThemed = new List<Image>();
        string themeDim = "";

        static Sprite WhiteSprite()
        {
            if (_whiteSprite == null)
            {
                var t = Texture2D.whiteTexture;
                _whiteSprite = Sprite.Create(t, new Rect(0, 0, t.width, t.height), new Vector2(0.5f, 0.5f));
            }
            return _whiteSprite;
        }

        // 圆角矩形（9-slice），让面板/按钮不再是硬直角，整体更现代
        static Sprite _roundSprite;
        static Sprite RoundSprite()
        {
            if (_roundSprite != null) return _roundSprite;
            const int N = 48; const float r = 16f;
            var t = new Texture2D(N, N, TextureFormat.RGBA32, false) { filterMode = FilterMode.Bilinear, wrapMode = TextureWrapMode.Clamp };
            var px = new Color32[N * N];
            for (int y = 0; y < N; y++)
                for (int x = 0; x < N; x++)
                {
                    float cx = Mathf.Clamp(x, r, N - 1 - r), cy = Mathf.Clamp(y, r, N - 1 - r);
                    float d = Mathf.Sqrt((x - cx) * (x - cx) + (y - cy) * (y - cy));
                    px[y * N + x] = new Color32(255, 255, 255, (byte)(Mathf.Clamp01(r - d + 0.5f) * 255));
                }
            t.SetPixels32(px); t.Apply(false);
            _roundSprite = Sprite.Create(t, new Rect(0, 0, N, N), new Vector2(0.5f, 0.5f), 100f, 0, SpriteMeshType.FullRect, new Vector4(r, r, r, r));
            return _roundSprite;
        }
        Image Round(Image img) { if (img != null) { img.sprite = RoundSprite(); img.type = Image.Type.Sliced; } return img; }

        // ====================== 清新玻璃质感调色板（统一配色，让整体不再灰暗发闷） ======================
        static class Pal
        {
            public static readonly Color Glass    = new Color(0.07f, 0.10f, 0.21f, 0.82f); // 深蓝玻璃面板
            public static readonly Color GlassSft  = new Color(0.09f, 0.13f, 0.25f, 0.66f); // 更透的玻璃（队伍/小条）
            public static readonly Color Slot      = new Color(0.11f, 0.15f, 0.29f, 0.90f); // 技能格
            public static readonly Color PanelBg   = new Color(0.06f, 0.08f, 0.18f, 0.97f); // 不透明面板/表单
            public static readonly Color BarBg     = new Color(0f, 0f, 0f, 0.42f);
            public static readonly Color Hp        = new Color(0.24f, 0.91f, 0.53f, 1f);     // 清新草绿
            public static readonly Color Exp       = new Color(0.56f, 0.57f, 1f, 1f);        // 长春花紫
            public static readonly Color Stroke    = new Color(0.44f, 0.66f, 1f, 0.55f);     // 冷色描边高光
            public static readonly Color StrokeSft = new Color(0.44f, 0.66f, 1f, 0.30f);
            public static readonly Color Accent    = new Color(0.17f, 0.83f, 1f, 1f);        // 清新青·主行动按钮
            public static readonly Color AccentDp  = new Color(0.10f, 0.52f, 0.76f, 1f);
            public static readonly Color Warm       = new Color(1f, 0.53f, 0.27f, 1f);        // 攻击·暖橙
            public static readonly Color Danger    = new Color(0.97f, 0.33f, 0.43f, 1f);
            public static readonly Color Gold      = new Color(1f, 0.83f, 0.36f, 1f);
            public static readonly Color TextDim   = new Color(0.75f, 0.81f, 0.97f, 1f);
            public static readonly Color Slate     = new Color(0.16f, 0.19f, 0.33f, 1f);      // 未选中按钮
        }

        // 圆角空心描边（9-slice），叠在面板上画出一圈干净的高光边框
        static Sprite _roundStroke;
        static Sprite RoundStrokeSprite()
        {
            if (_roundStroke != null) return _roundStroke;
            const int N = 48; const float margin = 1.5f, corner = 13f, thick = 2.2f, feather = 1.1f;
            var t = new Texture2D(N, N, TextureFormat.RGBA32, false) { filterMode = FilterMode.Bilinear, wrapMode = TextureWrapMode.Clamp };
            var px = new Color32[N * N];
            float c = (N - 1) / 2f, b = (N / 2f) - margin;
            for (int y = 0; y < N; y++)
                for (int x = 0; x < N; x++)
                {
                    float qx = Mathf.Abs(x - c) - b + corner, qy = Mathf.Abs(y - c) - b + corner;
                    float d = new Vector2(Mathf.Max(qx, 0), Mathf.Max(qy, 0)).magnitude + Mathf.Min(Mathf.Max(qx, qy), 0) - corner;
                    float a = 1f - Mathf.Clamp01((Mathf.Abs(d) - thick * 0.5f) / feather);
                    px[y * N + x] = new Color32(255, 255, 255, (byte)(a * 255));
                }
            t.SetPixels32(px); t.Apply(false);
            _roundStroke = Sprite.Create(t, new Rect(0, 0, N, N), new Vector2(0.5f, 0.5f), 100f, 0, SpriteMeshType.FullRect, new Vector4(18, 18, 18, 18));
            return _roundStroke;
        }

        // 竖向渐变（顶端不透明→底端透明，白色，可着色），用于登录背景光晕等
        static Sprite _gradSprite;
        static Sprite GradientSprite()
        {
            if (_gradSprite != null) return _gradSprite;
            const int H = 64;
            var t = new Texture2D(1, H, TextureFormat.RGBA32, false) { wrapMode = TextureWrapMode.Clamp, filterMode = FilterMode.Bilinear };
            var px = new Color32[H];
            for (int y = 0; y < H; y++) { float k = (float)y / (H - 1); px[y] = new Color32(255, 255, 255, (byte)(k * k * 255)); }
            t.SetPixels32(px); t.Apply(false);
            _gradSprite = Sprite.Create(t, new Rect(0, 0, 1, H), new Vector2(0.5f, 0.5f), 100f);
            return _gradSprite;
        }

        // 给面板加玻璃质感：圆角 + 一圈描边 + 顶部高光（描边/高光都置于最底层，不挡内容）
        void GlassPanel(Image panel, Color? border = null, bool sheen = true, bool themed = false)
        {
            if (panel == null) return;
            Round(panel);
            var stroke = MkImg("stroke", panel.transform, border ?? Pal.Stroke, Vector2.zero, Vector2.one, new Vector2(0.5f, 0.5f), Vector2.zero, Vector2.zero);
            stroke.sprite = RoundStrokeSprite(); stroke.type = Image.Type.Sliced; stroke.raycastTarget = false;
            stroke.transform.SetAsFirstSibling();
            if (themed) dimThemed.Add(stroke);
            if (sheen)
            {
                var sh = MkImg("sheen", panel.transform, new Color(1f, 1f, 1f, 0.13f), new Vector2(0, 1), new Vector2(1, 1), new Vector2(0.5f, 1), new Vector2(0, -5), new Vector2(-28, 4));
                Round(sh); sh.raycastTarget = false;
                sh.transform.SetAsFirstSibling();
            }
        }

        // 柔光（径向渐变，中心亮→边缘透明），用于霓虹辉光（ui-ux-pro-max 推荐的 HUD 发光效果）
        static Sprite _glowSprite;
        static Sprite SoftGlowSprite()
        {
            if (_glowSprite != null) return _glowSprite;
            const int N = 64; float c = (N - 1) / 2f;
            var t = new Texture2D(N, N, TextureFormat.RGBA32, false) { filterMode = FilterMode.Bilinear, wrapMode = TextureWrapMode.Clamp };
            var px = new Color32[N * N];
            for (int y = 0; y < N; y++)
                for (int x = 0; x < N; x++)
                {
                    float d = Mathf.Sqrt((x - c) * (x - c) + (y - c) * (y - c)) / c;   // 0 中心 → 1 边缘
                    float a = Mathf.Clamp01(1f - d); a *= a;                            // 平滑衰减
                    px[y * N + x] = new Color32(255, 255, 255, (byte)(a * 255));
                }
            t.SetPixels32(px); t.Apply(false);
            _glowSprite = Sprite.Create(t, new Rect(0, 0, N, N), new Vector2(0.5f, 0.5f), 100f);
            return _glowSprite;
        }

        // 加一圈呼吸辉光（置于元素底层，溢出到边框外形成光晕）
        void AddGlow(Transform parent, Color c, float pad)
        {
            var g = MkImg("glow", parent, new Color(c.r, c.g, c.b, 0.30f), Vector2.zero, Vector2.one, new Vector2(0.5f, 0.5f), Vector2.zero, Vector2.zero);
            g.rectTransform.offsetMin = new Vector2(-pad, -pad); g.rectTransform.offsetMax = new Vector2(pad, pad);
            g.sprite = SoftGlowSprite(); g.type = Image.Type.Simple; g.raycastTarget = false;
            g.transform.SetAsFirstSibling();
            g.gameObject.AddComponent<UiGlowPulse>();
        }

        // 加载转圈（圆环 + 角度渐隐拖尾），旋转即为 spinner（ui-ux-pro-max：异步必须有加载反馈）
        static Sprite _spinSprite;
        static Sprite SpinnerSprite()
        {
            if (_spinSprite != null) return _spinSprite;
            const int N = 64; float c = (N - 1) / 2f, rad = 0.72f, th = 0.18f;
            var t = new Texture2D(N, N, TextureFormat.RGBA32, false) { filterMode = FilterMode.Bilinear, wrapMode = TextureWrapMode.Clamp };
            var px = new Color32[N * N];
            for (int y = 0; y < N; y++)
                for (int x = 0; x < N; x++)
                {
                    float u = (x - c) / c, v = (y - c) / c;
                    float r = Mathf.Sqrt(u * u + v * v);
                    float ring = 1f - Mathf.Clamp01(Mathf.Abs(r - rad) / th);
                    float tail = (Mathf.Atan2(v, u) + Mathf.PI) / (2f * Mathf.PI);   // 0..1 拖尾
                    px[y * N + x] = new Color32(255, 255, 255, (byte)(Mathf.Clamp01(ring * tail) * 255));
                }
            t.SetPixels32(px); t.Apply(false);
            _spinSprite = Sprite.Create(t, new Rect(0, 0, N, N), new Vector2(0.5f, 0.5f), 100f);
            return _spinSprite;
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
            Round(img);   // 圆角按钮
            var b = img.gameObject.AddComponent<Button>();
            b.targetGraphic = img;
            var cb = b.colors;
            cb.highlightedColor = new Color(1.07f, 1.07f, 1.07f, 1f);   // 悬停微亮
            cb.pressedColor = new Color(1.22f, 1.22f, 1.22f, 1f);        // 按下提亮一下
            cb.selectedColor = cb.highlightedColor;
            cb.fadeDuration = 0.08f;
            b.colors = cb;
            b.gameObject.AddComponent<UiButtonFx>();                     // 按下回弹（强反馈感）
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
            var panel = MkImg("Status", root, Pal.Glass,
                new Vector2(0, 1), new Vector2(0, 1), new Vector2(0, 1), new Vector2(28, -30), new Vector2(540, 188));
            GlassPanel(panel, themed: true);
            uStatusTop = MkTxt("Top", panel.transform, "", 26, Color.white, TextAnchor.MiddleLeft,
                new Vector2(0, 1), new Vector2(1, 1), new Vector2(0, 1), new Vector2(18, -12), new Vector2(-30, 36));
            // HP 条
            Round(MkImg("HpBg", panel.transform, Pal.BarBg,
                new Vector2(0, 1), new Vector2(1, 1), new Vector2(0, 1), new Vector2(18, -56), new Vector2(-36, 34)));
            uHpFill = MkImg("HpFill", panel.transform, Pal.Hp,
                new Vector2(0, 1), new Vector2(1, 1), new Vector2(0, 1), new Vector2(20, -58), new Vector2(-40, 30));
            Round(uHpFill);
            uHpFill.type = Image.Type.Filled; uHpFill.fillMethod = Image.FillMethod.Horizontal; uHpFill.fillOrigin = 0;
            uHpText = MkTxt("HpTxt", panel.transform, "", 20, Color.white, TextAnchor.MiddleCenter,
                new Vector2(0, 1), new Vector2(1, 1), new Vector2(0.5f, 1), new Vector2(0, -56), new Vector2(-36, 34));
            // EXP 条
            Round(MkImg("ExpBg", panel.transform, Pal.BarBg,
                new Vector2(0, 1), new Vector2(1, 1), new Vector2(0, 1), new Vector2(18, -96), new Vector2(-36, 14)));
            uExpFill = MkImg("ExpFill", panel.transform, Pal.Exp,
                new Vector2(0, 1), new Vector2(1, 1), new Vector2(0, 1), new Vector2(20, -98), new Vector2(-40, 10));
            Round(uExpFill);
            uExpFill.type = Image.Type.Filled; uExpFill.fillMethod = Image.FillMethod.Horizontal; uExpFill.fillOrigin = 0;
            uStatusBot = MkTxt("Bot", panel.transform, "", 22, Pal.Gold, TextAnchor.MiddleLeft,
                new Vector2(0, 1), new Vector2(1, 1), new Vector2(0, 1), new Vector2(18, -118), new Vector2(-30, 34));

            // ---- 技能栏（底部居中） ----
            string[] keys = { "basic", "q", "e", "r", "dodge", "dim" };
            string[] klabel = { "攻击", "Q", "E", "R", "翻滚", "F" };
            float sw = 128, sh = 150, gap = 14;
            float totalW = keys.Length * sw + (keys.Length - 1) * gap;
            var barRoot = MkRect("SkillBar", root, new Vector2(0.5f, 0), new Vector2(0.5f, 0), new Vector2(0.5f, 0), new Vector2(0, 34), new Vector2(totalW, sh));
            for (int i = 0; i < keys.Length; i++)
            {
                float x = -totalW / 2 + i * (sw + gap);
                var slot = MkImg("Slot_" + keys[i], barRoot, Pal.Slot,
                    new Vector2(0, 0), new Vector2(0, 0), new Vector2(0, 0), new Vector2(x, 0), new Vector2(sw, sh));
                GlassPanel(slot, Pal.StrokeSft, themed: true);
                var us = new USkill { key = keys[i] };
                // 图标块（颜色随后在 Refresh 设）
                us.icon = MkImg("Icon", slot.transform, Color.white,
                    new Vector2(0, 1), new Vector2(1, 1), new Vector2(0.5f, 1), new Vector2(0, -10), new Vector2(sw - 20, 74));
                us.icon.preserveAspect = true;   // 方形字形图标居中、不被拉伸
                // 环形冷却覆盖
                us.cd = MkImg("Cd", slot.transform, new Color(0.02f, 0.03f, 0.08f, 0.66f),
                    new Vector2(0, 1), new Vector2(1, 1), new Vector2(0.5f, 1), new Vector2(0, -10), new Vector2(sw - 20, 74));
                us.cd.type = Image.Type.Filled; us.cd.fillMethod = Image.FillMethod.Radial360; us.cd.fillOrigin = 2; us.cd.fillAmount = 0;
                // 冷却结束闪光（默认透明，SetCd 里点亮后淡出）
                us.flash = MkImg("Flash", slot.transform, new Color(1f, 1f, 1f, 0f),
                    new Vector2(0, 1), new Vector2(1, 1), new Vector2(0.5f, 1), new Vector2(0, -10), new Vector2(sw - 20, 74));
                Round(us.flash); us.flash.raycastTarget = false;
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
                var scb = btn.colors; scb.highlightedColor = new Color(1.08f, 1.08f, 1.08f, 1f); scb.pressedColor = new Color(1.25f, 1.25f, 1.25f, 1f); scb.fadeDuration = 0.07f; btn.colors = scb;
                btn.onClick.AddListener(() => OnSkillTap(key));
                slot.gameObject.AddComponent<UiButtonFx>();   // 技能格按下回弹
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
            var atk = MkBtn("AttackBtn", root, Pal.Warm,
                new Vector2(1, 0), new Vector2(1, 0), new Vector2(1, 0), new Vector2(-46, 70), new Vector2(170, 170),
                () => Cast("basic"));
            GlassPanel((Image)atk.targetGraphic, new Color(1f, 0.74f, 0.45f, 0.7f));
            AddGlow(atk.transform, Pal.Warm, 34);   // 攻击键霓虹呼吸辉光
            BtnIcon(atk.transform, "ui_attack", "攻击", 96, 34);

            BuildOverlays(root);
            BuildParty(root);
            BuildMinimap(root);
            BuildPanelUI(root);
            BuildWorldCanvas();
            BuildMenu();
            hudBuilt = true;
        }

        // ---- 顶部横幅 / 信息流 / 升级 / 提示 / 死亡 ----
        GameObject MkBanner(Transform root, string name, Color bg, float topY, float w, out Text txt)
        {
            var p = MkImg(name, root, bg, new Vector2(0.5f, 1), new Vector2(0.5f, 1), new Vector2(0.5f, 1), new Vector2(0, topY), new Vector2(w, 44));
            GlassPanel(p, new Color(1f, 1f, 1f, 0.22f), false);
            txt = MkTxt("t", p.transform, "", 22, Color.white, TextAnchor.MiddleLeft,
                new Vector2(0, 0), new Vector2(1, 1), new Vector2(0, 0.5f), new Vector2(20, 0), new Vector2(-180, 0));
            p.gameObject.AddComponent<UiAppear>();   // 横幅弹出
            p.gameObject.SetActive(false);
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
            var luImg = MkImg("LevelUp", root, new Color(1f, 0.62f, 0.16f, 0.94f), new Vector2(0.5f, 1), new Vector2(0.5f, 1), new Vector2(0.5f, 1), new Vector2(0, -200), new Vector2(420, 70));
            GlassPanel(luImg, new Color(1f, 0.92f, 0.6f, 0.8f));
            uLevelUp = luImg.gameObject;
            uLevelUpTxt = MkTxt("t", uLevelUp.transform, "", 34, Color.white, TextAnchor.MiddleCenter, Vector2.zero, Vector2.one, new Vector2(0.5f, 0.5f), Vector2.zero, Vector2.zero);
            uLevelUp.AddComponent<UiAppear>();
            uLevelUp.SetActive(false);

            // 顶部提示 toast（屏幕中下）
            var toastImg = MkImg("Toast", root, Pal.Glass, new Vector2(0.5f, 0), new Vector2(0.5f, 0), new Vector2(0.5f, 0), new Vector2(0, 230), new Vector2(760, 44));
            GlassPanel(toastImg, Pal.StrokeSft, false);
            uToast = toastImg.gameObject;
            uToastTxt = MkTxt("t", uToast.transform, "", 22, Color.white, TextAnchor.MiddleCenter, Vector2.zero, Vector2.one, new Vector2(0.5f, 0.5f), Vector2.zero, Vector2.zero);
            uToast.AddComponent<UiAppear>();
            uToast.SetActive(false);

            // 死亡全屏
            uDeath = MkImg("Death", root, new Color(0.32f, 0.02f, 0.06f, 0.5f), Vector2.zero, Vector2.one, new Vector2(0.5f, 0.5f), Vector2.zero, Vector2.zero).gameObject;
            var dbox = MkImg("box", uDeath.transform, new Color(0.08f, 0.06f, 0.12f, 0.97f), new Vector2(0.5f, 0.5f), new Vector2(0.5f, 0.5f), new Vector2(0.5f, 0.5f), Vector2.zero, new Vector2(520, 240));
            GlassPanel(dbox, Pal.Danger);
            dbox.gameObject.AddComponent<UiAppear>();
            MkTxt("t", dbox.transform, "你已阵亡", 40, new Color(1f, 0.5f, 0.5f), TextAnchor.UpperCenter, new Vector2(0, 1), new Vector2(1, 1), new Vector2(0.5f, 1), new Vector2(0, -28), new Vector2(-20, 50));
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
                uWarTxt.text = $"{Data.Dim(a).name} {warInfo["killsA"]} : {warInfo["killsB"]} {Data.Dim(b).name}";
                bool mine = myDim == a || myDim == b;
                uWarBtn.gameObject.SetActive(mine);
                uWarBtnTxt.text = curRoom == "war" ? "撤离" : "进入";
            }
            // BOSS 横幅
            bool bossOn = bossInfo != null;
            uBoss.SetActive(bossOn);
            if (bossOn)
            {
                string bd = (string)bossInfo["dim"];
                uBossTxt.text = bd == myDim ? $"世界BOSS【{bossInfo["name"]}】就在本次元巢穴！" : $"世界BOSS【{bossInfo["name"]}】肆虐【{Data.Dim(bd).name}】";
            }
            // 大混战横幅
            bool meleeOn = meleeInfo != null && (bool?)meleeInfo["active"] == true;
            uMelee.SetActive(meleeOn);
            if (meleeOn) uMeleeBtnTxt.text = curRoom == "melee" ? "撤离" : "杀入";

            // 信息流
            for (int i = 0; i < uFeed.Length; i++)
            {
                if (i < feed.Count && Time.time - feedAt[i] < 12f) uFeed[i].text = feed[i];
                else uFeed[i].text = "";
            }

            // 升级
            bool lu = Time.time < levelUpUntil;
            uLevelUp.SetActive(lu);
            if (lu) uLevelUpTxt.text = $"升级！Lv.{levelUpLevel}" + (levelUpLevel == 3 ? "  E解锁" : levelUpLevel == 5 ? "  R解锁" : "");

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
                uRespawnTxt.text = arena ? "回本次元复活" : "立即复活";
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
            RefreshMenu(playing);   // 登录/连接界面（非游戏态显示）
            if (plateCanvas != null && plateCanvas.enabled != playing) plateCanvas.enabled = playing;
            if (!playing) return;

            // 不同次元不同风格：HUD 描边随玩家所在次元换色（含换角色后重染）
            if (themeDim != myDim && !string.IsNullOrEmpty(myDim))
            {
                themeDim = myDim;
                var ac = Data.Dim(myDim).accent;
                foreach (var s in dimThemed) if (s != null) s.color = new Color(ac.r, ac.g, ac.b, 0.62f);
            }

            int hp = you != null ? (int?)you["hp"] ?? 0 : 0;
            int maxHp = you != null ? (int?)you["maxHp"] ?? 1 : 1;
            int shield = you != null ? (int?)you["shield"] ?? 0 : 0;
            int exp = you != null ? (int?)you["exp"] ?? 0 : 0;
            int expNeed = you != null ? (int?)you["expNeed"] ?? 1 : 1;
            int gold = you != null ? (int?)you["gold"] ?? 0 : 0;
            var roomName = curRoom == "war" ? "重叠战场" : curRoom == "melee" ? "大混战" : Data.Dim(myDim).name;
            uStatusTop.text = $"{roomName} ｜ {Data.ClassTitle(myDim, myCls)}";
            Fill(uHpFill, Mathf.Clamp01((float)hp / maxHp));
            uHpText.text = shield > 0 ? $"{hp}/{maxHp}  盾{shield}" : $"{hp}/{maxHp}";
            Fill(uExpFill, Mathf.Clamp01((float)exp / expNeed));
            uStatusBot.text = $"Lv.{MyLevel} ｜ 金{gold}" + (MySkPts > 0 ? $"  技能点×{MySkPts}" : "");

            RefreshOverlays();
            RefreshParty();
            RefreshMinimap();
            RefreshPanel();

            var def = Data.Cls(myCls);
            foreach (var us in uSkills)
            {
                if (us.key == "dodge")
                {
                    SetSkillIcon(us, "ui_dodge", "dodge", new Color(0.55f, 0.78f, 1f), false);
                    us.nameText.text = "翻滚闪避"; us.lvText.text = "";
                    SetCd(us, Mathf.Max(0, dodgeReadyAt - Time.time), 1.2f);
                    us.plus.SetActive(false);
                }
                else if (us.key == "dim")
                {
                    SetSkillIcon(us, "dim_" + myDim, "dim", Data.Dim(myDim).accent, false);
                    us.nameText.text = dimSkillName; us.lvText.text = "";
                    SetCd(us, Mathf.Max(0, captureReadyAt - Time.time), dimSkillCd > 0 ? dimSkillCd : 3f);
                    us.plus.SetActive(false);
                }
                else
                {
                    var sk = def.Skill(us.key);
                    bool locked = sk.minLvl > 0 && MyLevel < sk.minLvl;
                    SetSkillIcon(us, "sk_" + myCls + "_" + us.key, sk.kind, KindColor(sk.kind), locked);
                    us.nameText.text = locked ? sk.name + "(锁)" : sk.name;
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
            // 冷却归零瞬间，技能格闪一下白光，然后淡出 —— “可以放了”的动感提示
            bool ready = remain <= 0.02f;
            if (us.flash != null)
            {
                if (ready && !us.wasReady) { var a = Data.Dim(myDim).accent; us.flash.color = new Color(a.r, a.g, a.b, 0.6f); }
                var fc = us.flash.color; fc.a = Mathf.MoveTowards(fc.a, 0f, Time.deltaTime * 1.9f); us.flash.color = fc;
            }
            us.wasReady = ready;
        }

        // 平滑过渡填充条：每帧朝目标缓动（指数衰减，与帧率无关），让掉血/涨经验有“流动”感
        static void Fill(Image img, float target)
        {
            if (img == null) return;
            float c = img.fillAmount;
            img.fillAmount = Mathf.Abs(target - c) < 0.002f ? target : Mathf.Lerp(c, target, 1f - Mathf.Exp(-13f * Time.deltaTime));
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

        // ====================== 霓虹图标（白核 + 同色辉光，透明底）—— 全套统一矢量，按字形+辉光色缓存 ======================
        static readonly Dictionary<string, Sprite> _neonIcons = new Dictionary<string, Sprite>();
        static Sprite NeonIcon(string kind, Color glow, bool locked)
        {
            string key = kind + "|" + ColorUtility.ToHtmlStringRGB(glow) + (locked ? "L" : "");
            if (_neonIcons.TryGetValue(key, out var cached)) return cached;
            const int N = 96;
            var buf = new Color[N * N];
            float feather = 1.7f / N;
            Color core = locked ? new Color(0.66f, 0.70f, 0.80f) : Color.white;
            Color gl = locked ? new Color(glow.r * 0.45f + 0.18f, glow.g * 0.45f + 0.18f, glow.b * 0.45f + 0.20f) : glow;
            for (int y = 0; y < N; y++)
                for (int x = 0; x < N; x++)
                {
                    float u = (x + 0.5f) / N * 2f - 1f;
                    float v = (y + 0.5f) / N * 2f - 1f;
                    float d = GlyphSdf(kind, new Vector2(u, v));            // <0 字形内部
                    float fill = Mathf.Clamp01(0.5f - d / feather);        // 1=字形实心(白核)
                    float halo = Mathf.Exp(-Mathf.Max(d, 0f) * 7.5f);      // 边缘→外渐隐的辉光
                    float a = Mathf.Clamp01(Mathf.Max(fill, halo * 0.8f));
                    Color col = Color.Lerp(gl, core, fill);
                    buf[y * N + x] = new Color(col.r, col.g, col.b, a);
                }
            var tex = new Texture2D(N, N, TextureFormat.RGBA32, false) { filterMode = FilterMode.Bilinear, wrapMode = TextureWrapMode.Clamp };
            tex.SetPixels(buf); tex.Apply(false);
            var sp = Sprite.Create(tex, new Rect(0, 0, N, N), new Vector2(0.5f, 0.5f), 100f);
            _neonIcons[key] = sp;
            return sp;
        }

        // ====================== 各次元专属图标质感（同一字形，五种风格）======================
        static readonly Dictionary<string, Sprite> _dimIcons = new Dictionary<string, Sprite>();
        static Sprite DimIcon(string glyphKey, string dimId, bool locked)
        {
            string key = glyphKey + "@" + dimId + (locked ? "L" : "");
            if (_dimIcons.TryGetValue(key, out var cached)) return cached;
            const int N = 112;
            var buf = new Color[N * N];
            Color accent = Data.Dim(dimId).accent;
            for (int yy = 0; yy < N; yy++)
                for (int xx = 0; xx < N; xx++)
                {
                    float u = (xx + 0.5f) / N * 2f - 1f;
                    float v = (yy + 0.5f) / N * 2f - 1f;
                    Color c = DimIconPixel(glyphKey, dim: dimId, ac: accent, p: new Vector2(u, v));
                    if (locked)
                    {
                        float g = (c.r + c.g + c.b) / 3f;
                        c = new Color(Mathf.Lerp(g, c.r, 0.35f) * 0.72f, Mathf.Lerp(g, c.g, 0.35f) * 0.72f, Mathf.Lerp(g, c.b, 0.35f) * 0.72f, c.a * 0.9f);
                    }
                    buf[yy * N + xx] = c;
                }
            var tex = new Texture2D(N, N, TextureFormat.RGBA32, false) { filterMode = FilterMode.Bilinear, wrapMode = TextureWrapMode.Clamp };
            tex.SetPixels(buf); tex.Apply(false);
            var sp = Sprite.Create(tex, new Rect(0, 0, N, N), new Vector2(0.5f, 0.5f), 100f);
            _dimIcons[key] = sp;
            return sp;
        }

        static float IFill(float d) { return Mathf.Clamp01(0.5f - d / 0.022f); }
        static float IGlow(float d, float k) { return Mathf.Exp(-Mathf.Max(d, 0f) * k); }
        static float IHash(Vector2 p) { float s = Mathf.Sin(p.x * 12.9898f + p.y * 78.233f) * 43758.5453f; return s - Mathf.Floor(s); }

        static Color DimIconPixel(string k, string dim, Color ac, Vector2 p)
        {
            switch (dim)
            {
                case "xiuxian":   // 修仙：金核翠光符箓 + 柔和灵气环
                {
                    float d = GlyphSdf(k, p);
                    float fill = IFill(d), glow = IGlow(d, 5.5f);
                    float halo = Mathf.Exp(-Mathf.Abs(p.magnitude - 0.82f) * 6f) * 0.22f;
                    Color col = Color.Lerp(ac, new Color(0.99f, 0.96f, 0.72f), fill);
                    float a = Mathf.Max(fill, Mathf.Max(glow * 0.7f, halo));
                    return new Color(col.r, col.g, col.b, a);
                }
                case "cyber":     // 赛博：故障霓虹（RGB 错位 + 扫描线）
                {
                    float off = 0.05f;
                    float dC = GlyphSdf(k, p);
                    float fC = IFill(dC), fR = IFill(GlyphSdf(k, p - new Vector2(off, 0f))), fB = IFill(GlyphSdf(k, p + new Vector2(off, 0f)));
                    float glow = IGlow(dC, 8f);
                    float r = Mathf.Clamp01(Mathf.Max(fR, ac.r * fC + glow * ac.r * 0.7f));
                    float g = Mathf.Clamp01(Mathf.Max(fC * 0.35f, glow * ac.g * 0.7f));
                    float b = Mathf.Clamp01(Mathf.Max(fB, ac.b * fC + glow * ac.b * 0.7f));
                    float a = Mathf.Clamp01(Mathf.Max(Mathf.Max(fR, fB), Mathf.Max(fC, glow * 0.8f)));
                    float scan = (Mathf.FloorToInt((p.y * 0.5f + 0.5f) * 112f) % 3 == 0) ? 0.7f : 1f;
                    return new Color(r * scan, g * scan, b * scan, a);
                }
                case "magic":     // 西方魔法：奥术法阵（双环 + 符文刻度）
                {
                    float d = GlyphSdf(k, p);
                    float fill = IFill(d), glow = IGlow(d, 7f);
                    float rr = p.magnitude;
                    float ring1 = Mathf.Clamp01(0.5f - (Mathf.Abs(rr - 0.95f) - 0.012f) / 0.02f) * 0.45f;
                    float ring2 = Mathf.Clamp01(0.5f - (Mathf.Abs(rr - 0.8f) - 0.008f) / 0.02f) * 0.38f;
                    float seg = Mathf.Repeat(Mathf.Atan2(p.y, p.x) / (Mathf.PI * 2f) * 8f, 1f);
                    float tick = (rr > 0.84f && rr < 0.92f && Mathf.Min(seg, 1f - seg) < 0.07f) ? 0.5f : 0f;
                    float deco = Mathf.Max(Mathf.Max(ring1, ring2), tick);
                    Color col = Color.Lerp(ac, new Color(1f, 0.96f, 1f), fill);
                    float a = Mathf.Max(fill, Mathf.Max(glow * 0.75f, deco));
                    return new Color(col.r, col.g, col.b, a);
                }
                case "hunter":    // 猎人：粗糙边缘 + 三道爪痕 + 琥珀光
                {
                    float n = (IHash(p * 8f) - 0.5f) * 0.05f;
                    float d = GlyphSdf(k, p) + n;
                    float fill = IFill(d), glow = IGlow(d, 6.5f);
                    float c1 = SdSeg(p, new Vector2(-0.8f, 0.55f), new Vector2(0.55f, -0.85f), 0.022f);
                    float c2 = SdSeg(p, new Vector2(-0.6f, 0.8f), new Vector2(0.8f, -0.6f), 0.022f);
                    float c3 = SdSeg(p, new Vector2(-0.85f, 0.3f), new Vector2(0.3f, -0.85f), 0.022f);
                    float claw = Mathf.Clamp01(0.5f - Mathf.Min(c1, Mathf.Min(c2, c3)) / 0.02f) * 0.28f;
                    Color col = Color.Lerp(ac, new Color(1f, 0.92f, 0.66f), fill);
                    float a = Mathf.Max(fill, Mathf.Max(glow * 0.7f, claw));
                    return new Color(col.r, col.g, col.b, a);
                }
                default:          // 科技：洁净霓虹线 + 细瞄准环
                {
                    float d = GlyphSdf(k, p);
                    float fill = IFill(d), glow = IGlow(d, 8.5f);
                    float ring = Mathf.Clamp01(0.5f - (Mathf.Abs(p.magnitude - 0.94f) - 0.01f) / 0.02f) * 0.5f;
                    Color col = Color.Lerp(ac, Color.white, fill);
                    float a = Mathf.Max(fill, Mathf.Max(glow * 0.8f, ring));
                    return new Color(col.r, col.g, col.b, a);
                }
            }
        }

        // ====================== 美术图标（game-icons.net CC BY，存 Resources/DWIcons，白图运行时着色；缺失→SDF 兜底） ======================
        static readonly Dictionary<string, Sprite> _pngIcons = new Dictionary<string, Sprite>();
        static Sprite PngIcon(string name)
        {
            if (_pngIcons.TryGetValue(name, out var sp)) return sp;
            var t = Resources.Load<Texture2D>("DWIcons/" + name);
            sp = t != null ? Sprite.Create(t, new Rect(0, 0, t.width, t.height), new Vector2(0.5f, 0.5f), 100f) : null;
            _pngIcons[name] = sp;
            return sp;
        }
        // 技能格图标：优先用 game-icons.net 真图标（按技能着色），缺失才回退程序化字形。
        void SetSkillIcon(USkill us, string iconName, string glyphKind, Color tint, bool locked)
        {
            var png = PngIcon(iconName);
            if (png != null)
            {
                us.icon.sprite = png;
                us.icon.color = locked ? new Color(tint.r * 0.42f, tint.g * 0.42f, tint.b * 0.48f, 1f) : tint;
            }
            else
            {
                us.icon.sprite = DimIcon(glyphKind, myDim, locked);
                us.icon.color = Color.white;
            }
        }
        // 按钮图标：优先 game-icons.net 真图标，缺失回退程序化字形
        void BtnIcon(Transform parent, string iconName, string fallbackText, float iconSize, int fontSize)
        {
            var img = MkImg("ic", parent, Color.white, new Vector2(0.5f, 0.5f), new Vector2(0.5f, 0.5f), new Vector2(0.5f, 0.5f), Vector2.zero, new Vector2(iconSize, iconSize));
            var png = PngIcon(iconName);
            if (png != null) img.sprite = png;
            else img.sprite = NeonIcon(iconName == "ui_attack" ? "attack" : iconName == "ui_bag" ? "bag" : "exit", Color.white, false);
            img.preserveAspect = true; img.raycastTarget = false;
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
                case "attack":   // 攻击→交叉双剑
                    return Mathf.Min(
                        SdSeg(p, new Vector2(-0.46f, -0.46f), new Vector2(0.46f, 0.46f), 0.11f),
                        SdSeg(p, new Vector2(-0.46f, 0.46f), new Vector2(0.46f, -0.46f), 0.11f));
                case "close":    // 关闭→叉
                    return Mathf.Min(
                        SdSeg(p, new Vector2(-0.4f, -0.4f), new Vector2(0.4f, 0.4f), 0.09f),
                        SdSeg(p, new Vector2(-0.4f, 0.4f), new Vector2(0.4f, -0.4f), 0.09f));
                case "bag":      // 背包→包体+提手+扣带
                {
                    float body = Mathf.Abs(SdBox(p - new Vector2(0f, -0.08f), new Vector2(0.34f, 0.34f))) - 0.065f;
                    float handle = Mathf.Max(Mathf.Abs(SdCircle(p - new Vector2(0f, 0.30f), 0.18f)) - 0.06f, 0.30f - p.y);
                    float buckle = SdSeg(p, new Vector2(-0.34f, -0.02f), new Vector2(0.34f, -0.02f), 0.05f);
                    float tab = SdBox(p - new Vector2(0f, -0.18f), new Vector2(0.08f, 0.06f));
                    return Mathf.Min(Mathf.Min(body, handle), Mathf.Min(buckle, tab));
                }
                case "exit":     // 退出→门框+外向箭头
                {
                    float frame = Mathf.Abs(SdBox(p - new Vector2(-0.22f, 0f), new Vector2(0.2f, 0.46f))) - 0.06f;
                    float shaft = SdSeg(p, new Vector2(-0.06f, 0f), new Vector2(0.46f, 0f), 0.075f);
                    float a1 = SdSeg(p, new Vector2(0.46f, 0f), new Vector2(0.24f, 0.2f), 0.075f);
                    float a2 = SdSeg(p, new Vector2(0.46f, 0f), new Vector2(0.24f, -0.2f), 0.075f);
                    return Mathf.Min(frame, Mathf.Min(shaft, Mathf.Min(a1, a2)));
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

        // ---- 装备图标：按部位画字形（剑/盔/盾/靴/项链），底色=品质色，缓存 (slot,品质色) ----
        readonly Dictionary<string, Sprite> _slotIcons = new Dictionary<string, Sprite>();

        Sprite SlotIcon(string slot, Color bg)
        {
            string key = (string.IsNullOrEmpty(slot) ? "?" : slot) + ":" + ColorUtility.ToHtmlStringRGB(bg);
            if (_slotIcons.TryGetValue(key, out var cached)) return cached;
            const int N = 64;
            var buf = new Color32[N * N];
            Color bgDark = new Color(bg.r * 0.42f, bg.g * 0.42f, bg.b * 0.5f, 1f);
            float feather = 2.4f / N;
            for (int y = 0; y < N; y++)
                for (int x = 0; x < N; x++)
                {
                    float u = (x + 0.5f) / N * 2f - 1f;
                    float v = (y + 0.5f) / N * 2f - 1f;
                    var p = new Vector2(u, v);
                    float edge = Mathf.Clamp01(1f - 0.5f * Mathf.Max(Mathf.Abs(u), Mathf.Abs(v)));
                    Color baseCol = Color.Lerp(bgDark, bg, edge);
                    float d = SlotGlyphSdf(slot, p);
                    float cov = Mathf.Clamp01(0.5f - d / feather);
                    buf[y * N + x] = Color.Lerp(baseCol, Color.white, cov);
                }
            var tex = new Texture2D(N, N, TextureFormat.RGBA32, false) { filterMode = FilterMode.Bilinear, wrapMode = TextureWrapMode.Clamp };
            tex.SetPixels32(buf); tex.Apply(false);
            var sp = Sprite.Create(tex, new Rect(0, 0, N, N), new Vector2(0.5f, 0.5f), 100f);
            _slotIcons[key] = sp;
            return sp;
        }

        static float SlotGlyphSdf(string slot, Vector2 p)
        {
            switch (slot)
            {
                case "weapon":   // 剑
                {
                    float blade = SdBox(p - new Vector2(0, 0.02f), new Vector2(0.08f, 0.42f));
                    float tip = SdTri(p, new Vector2(0, 0.62f), new Vector2(-0.12f, 0.4f), new Vector2(0.12f, 0.4f));
                    float guard = SdBox(p - new Vector2(0, -0.4f), new Vector2(0.3f, 0.07f));
                    float grip = SdBox(p - new Vector2(0, -0.56f), new Vector2(0.07f, 0.12f));
                    return Mathf.Min(Mathf.Min(blade, tip), Mathf.Min(guard, grip));
                }
                case "helmet":   // 头盔（圆顶+帽檐）
                    return Mathf.Min(
                        Mathf.Max(SdCircle(p - new Vector2(0, 0.02f), 0.46f), -(p.y + 0.06f)),
                        SdBox(p - new Vector2(0, -0.12f), new Vector2(0.56f, 0.08f)));
                case "armor":    // 护甲/盾
                    return Mathf.Min(
                        SdBox(p - new Vector2(0, 0.16f), new Vector2(0.4f, 0.3f)),
                        SdTri(p, new Vector2(0, -0.6f), new Vector2(-0.4f, -0.14f), new Vector2(0.4f, -0.14f)));
                case "boots":    // 靴
                    return Mathf.Min(
                        SdBox(p - new Vector2(-0.06f, 0.12f), new Vector2(0.16f, 0.42f)),
                        SdBox(p - new Vector2(0.12f, -0.4f), new Vector2(0.34f, 0.13f)));
                case "acc":      // 饰品（项链：圆环+吊坠）
                {
                    float ring = Mathf.Abs(SdCircle(p - new Vector2(0, -0.06f), 0.34f)) - 0.08f;
                    float gem = SdBox(Rot45(p - new Vector2(0, 0.46f)), new Vector2(0.13f, 0.13f));
                    return Mathf.Min(ring, gem);
                }
                default:         // 通用装备（菱形）
                    return SdBox(Rot45(p), new Vector2(0.34f, 0.34f));
            }
        }

        // ====================== 队伍小血条（左侧） ======================
        void BuildParty(Transform root)
        {
            // 状态面板高 188、距顶 24，故从 ~ -228 起向下排
            const int maxRows = 5;
            for (int i = 0; i < maxRows; i++)
            {
                var box = MkImg("Party" + i, root, Pal.GlassSft,
                    new Vector2(0, 1), new Vector2(0, 1), new Vector2(0, 1), new Vector2(24, -228 - i * 56), new Vector2(300, 50));
                GlassPanel(box, Pal.StrokeSft, false);
                var name = MkTxt("n", box.transform, "", 18, Color.white, TextAnchor.UpperLeft,
                    new Vector2(0, 1), new Vector2(1, 1), new Vector2(0, 1), new Vector2(10, -4), new Vector2(-16, 24));
                Round(MkImg("bg", box.transform, Pal.BarBg,
                    new Vector2(0, 0), new Vector2(1, 0), new Vector2(0, 0), new Vector2(10, 8), new Vector2(-20, 12)));
                var fill = MkImg("fill", box.transform, Pal.Hp,
                    new Vector2(0, 0), new Vector2(1, 0), new Vector2(0, 0), new Vector2(11, 9), new Vector2(-22, 10));
                Round(fill);
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
                uParty[i].name.text = $"{m["name"]} Lv.{m["level"]}";
                Fill(uParty[i].hpFill, Mathf.Clamp01((float)hp / Mathf.Max(1, max)));
            }
        }

        // ====================== 小地图（左下角） ======================
        void BuildMinimap(Transform root)
        {
            // 边框 + 画布（左下角，抬高到技能栏之上，避免最左技能格被压住）
            var frame = MkImg("MiniFrame", root, Pal.Glass,
                new Vector2(0, 0), new Vector2(0, 0), new Vector2(0, 0), new Vector2(26, 196), new Vector2(210, 210));
            GlassPanel(frame, Pal.Stroke, false, true);
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

        float uMiniNext;
        void RefreshMinimap()
        {
            if (uMiniTex == null) return;
            if (Time.time < uMiniNext) return;          // ~12.5Hz 重绘即可，省移动端 CPU
            uMiniNext = Time.time + 0.08f;
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

        // ====================== 头顶名牌（怪物/玩家/宠物血条）+ 伤害飘字 ======================
        void BuildWorldCanvas()
        {
            EnsureEventSystem();
            var go = new GameObject("DW_World_Canvas");
            DontDestroyOnLoad(go);
            plateCanvas = go.AddComponent<Canvas>();
            plateCanvas.renderMode = RenderMode.ScreenSpaceOverlay;
            plateCanvas.sortingOrder = 5;   // 世界之上、HUD(10) 之下
            var scaler = go.AddComponent<CanvasScaler>();
            scaler.uiScaleMode = CanvasScaler.ScaleMode.ScaleWithScreenSize;
            scaler.referenceResolution = new Vector2(1920, 1080);
            scaler.screenMatchMode = CanvasScaler.ScreenMatchMode.MatchWidthOrHeight;
            scaler.matchWidthOrHeight = 0.5f;
            plateRoot = (RectTransform)go.transform;
        }

        void EnsurePlate(Ent e, bool monster)
        {
            bool boss = monster && e.tier >= 5;
            float w = boss ? 300 : 168;
            var box = MkRect("plate", plateRoot, new Vector2(0.5f, 0.5f), new Vector2(0.5f, 0.5f), new Vector2(0.5f, 0.5f), Vector2.zero, new Vector2(w, 42));
            e.plate = box.gameObject; e.plateRt = box;
            e.plateName = MkTxt("n", box, "", boss ? 24 : 17, Color.white, TextAnchor.LowerCenter,
                new Vector2(0, 1), new Vector2(1, 1), new Vector2(0.5f, 1), new Vector2(0, 0), new Vector2(0, 24));
            MkImg("bg", box, new Color(0, 0, 0, 0.66f),
                new Vector2(0, 0), new Vector2(1, 0), new Vector2(0.5f, 0), new Vector2(0, 2), new Vector2(-14, boss ? 12 : 9));
            e.plateFill = MkImg("fill", box, Color.green,
                new Vector2(0, 0), new Vector2(1, 0), new Vector2(0.5f, 0), new Vector2(0, 3), new Vector2(-16, boss ? 10 : 7));
            e.plateFill.type = Image.Type.Filled; e.plateFill.fillMethod = Image.FillMethod.Horizontal; e.plateFill.fillOrigin = 0;
        }

        void UpdatePlateGroup(Dictionary<string, Ent> dict, bool monster)
        {
            if (plateRoot == null) return;
            foreach (var e in dict.Values)
            {
                if (e.go == null || e.dead || !e.go.activeSelf) { if (e.plate != null) e.plate.SetActive(false); continue; }
                Vector3 sp = cam.WorldToScreenPoint(e.go.transform.position + Vector3.up * (e.plateH > 0 ? e.plateH : 2.2f));
                if (sp.z <= 0.2f) { if (e.plate != null) e.plate.SetActive(false); continue; }
                if (e.plate == null) EnsurePlate(e, monster);
                if (!e.plate.activeSelf) e.plate.SetActive(true);
                Vector2 lp;
                RectTransformUtility.ScreenPointToLocalPointInRectangle(plateRoot, sp, null, out lp);
                e.plateRt.localPosition = lp;
                Fill(e.plateFill, Mathf.Clamp01((float)e.hp / Mathf.Max(1, e.maxHp)));
                if (e.level != e.plateLvl)   // 名字固定、只在等级变化时重建文本（省每帧字符串分配）
                {
                    e.plateLvl = e.level;
                    bool friendly = !monster && (e.isPet || e.dim == myDim);
                    bool boss = monster && e.tier >= 5;
                    e.plateName.text = e.isPet ? e.name : $"{e.name} Lv.{e.level}";
                    e.plateName.color = boss ? new Color(1f, 0.84f, 0.3f) : monster ? new Color(1f, 0.72f, 0.45f)
                        : friendly ? new Color(0.55f, 0.98f, 0.62f) : new Color(1f, 0.5f, 0.55f);
                    e.plateFill.color = friendly ? new Color(0.25f, 0.85f, 0.32f) : boss ? new Color(1f, 0.5f, 0.16f) : new Color(0.92f, 0.34f, 0.34f);
                }
            }
        }

        void DestroyPlate(Ent e)
        {
            if (e != null && e.plate != null)
            {
                Destroy(e.plate);
                e.plate = null; e.plateRt = null; e.plateFill = null; e.plateName = null; e.plateLvl = -1;
            }
        }

        // 屏幕空间伤害/治疗飘字（由世界坐标投影），向上飘+淡出由 UiFloat 驱动
        void FloatText(string txt, Vector3 at, Color c)
        {
            if (plateRoot == null || cam == null) return;
            Vector3 sp = cam.WorldToScreenPoint(at + new Vector3(UnityEngine.Random.Range(-0.5f, 0.5f), 2.4f, 0));
            if (sp.z <= 0.2f) return;
            var t = MkTxt("dmg", plateRoot, txt, 34, c, TextAnchor.MiddleCenter,
                new Vector2(0.5f, 0.5f), new Vector2(0.5f, 0.5f), new Vector2(0.5f, 0.5f), Vector2.zero, new Vector2(260, 46));
            t.fontStyle = FontStyle.Bold;
            Vector2 lp;
            RectTransformUtility.ScreenPointToLocalPointInRectangle(plateRoot, sp, null, out lp);
            t.rectTransform.localPosition = lp;
            t.gameObject.AddComponent<UiFloat>();
        }

        // ====================== 登录 / 连接界面（UGUI，替代 IMGUI GuiMenu） ======================
        void BuildMenu()
        {
            EnsureEventSystem();
            var go = new GameObject("DW_Menu_Canvas");
            DontDestroyOnLoad(go);
            menuCanvas = go.AddComponent<Canvas>();
            menuCanvas.renderMode = RenderMode.ScreenSpaceOverlay;
            menuCanvas.sortingOrder = 30;   // 盖住世界/HUD
            var scaler = go.AddComponent<CanvasScaler>();
            scaler.uiScaleMode = CanvasScaler.ScaleMode.ScaleWithScreenSize;
            scaler.referenceResolution = new Vector2(1920, 1080);
            scaler.screenMatchMode = CanvasScaler.ScreenMatchMode.MatchWidthOrHeight;
            scaler.matchWidthOrHeight = 0.5f;
            go.AddComponent<GraphicRaycaster>();
            var root = go.transform;
            MkImg("dim", root, new Color(0.035f, 0.045f, 0.10f, 0.985f), Vector2.zero, Vector2.one, new Vector2(0.5f, 0.5f), Vector2.zero, Vector2.zero);
            // 顶部彩色光晕（渐变），随所选次元换色，让登录界面有空气感与动感
            menuGlow = MkImg("glow", root, new Color(0.2f, 0.45f, 0.9f, 0.22f), Vector2.zero, Vector2.one, new Vector2(0.5f, 0.5f), Vector2.zero, Vector2.zero);
            menuGlow.sprite = GradientSprite(); menuGlow.type = Image.Type.Simple; menuGlow.raycastTarget = false;
            uMenuToast = MkTxt("toast", root, "", 22, new Color(1f, 0.85f, 0.5f), TextAnchor.LowerCenter,
                new Vector2(0.5f, 0), new Vector2(0.5f, 0), new Vector2(0.5f, 0), new Vector2(0, 60), new Vector2(960, 40));

            // ---- 表单 ----
            var panel = MkImg("Form", root, Pal.PanelBg,
                new Vector2(0.5f, 0.5f), new Vector2(0.5f, 0.5f), new Vector2(0.5f, 0.5f), Vector2.zero, new Vector2(760, 880));
            GlassPanel(panel, Pal.Stroke);
            menuForm = panel.gameObject;
            menuForm.AddComponent<UiAppear>();
            var pt = panel.transform;
            float pw = 760;
            Text Label(string s, float yy) => MkTxt("l", pt, s, 22, Pal.TextDim, TextAnchor.UpperLeft,
                new Vector2(0, 1), new Vector2(1, 1), new Vector2(0.5f, 1), new Vector2(0, yy), new Vector2(-56, 30));

            var title = MkTxt("title", pt, "次元大战", 54, Pal.Gold, TextAnchor.UpperCenter,
                new Vector2(0, 1), new Vector2(1, 1), new Vector2(0.5f, 1), new Vector2(0, -26), new Vector2(0, 68));
            title.gameObject.AddComponent<UiPulse>();   // 标题轻轻呼吸
            MkTxt("sub", pt, "五大次元 · 实时混战 · 选择你的阵营降临", 18, Pal.TextDim, TextAnchor.UpperCenter,
                new Vector2(0, 1), new Vector2(1, 1), new Vector2(0.5f, 1), new Vector2(0, -96), new Vector2(0, 24));
            float y = -134;
            Label("降临者之名", y); y -= 34;
            uName = MkInput(pt, playerName, 12, y, v => playerName = v); y -= 70;

            Label("选择次元", y); y -= 34;
            uDimBtns = new Button[Data.Dims.Length];
            float dw = (pw - 48 - (Data.Dims.Length - 1) * 8) / Data.Dims.Length;
            for (int i = 0; i < Data.Dims.Length; i++)
            {
                int idx = i;
                float xc = -pw / 2 + 24 + dw / 2 + i * (dw + 8);
                uDimBtns[i] = MkBtn("dim" + i, pt, Pal.Slate,
                    new Vector2(0.5f, 1), new Vector2(0.5f, 1), new Vector2(0.5f, 1), new Vector2(xc, y), new Vector2(dw, 54),
                    () => dimIdx = idx);
                MkTxt("t", uDimBtns[i].transform, Data.Dims[i].name.Replace("世界", ""), 19, Color.white, TextAnchor.MiddleCenter,
                    Vector2.zero, Vector2.one, new Vector2(0.5f, 0.5f), new Vector2(0, 4), Vector2.zero);
                // 每个次元自带身份色条 —— 不同次元不同风格，一眼可辨
                var bar = MkImg("dimc", uDimBtns[i].transform, Data.Dims[i].accent,
                    new Vector2(0.18f, 0), new Vector2(0.82f, 0), new Vector2(0.5f, 0), new Vector2(0, 7), new Vector2(0, 5));
                Round(bar); bar.raycastTarget = false;
            }
            y -= 62;
            uHunterHint = MkTxt("hh", pt, "", 18, new Color(1f, 0.82f, 0.4f), TextAnchor.UpperLeft,
                new Vector2(0, 1), new Vector2(1, 1), new Vector2(0.5f, 1), new Vector2(0, y), new Vector2(-56, 26)); y -= 30;

            Label("选择职业", y); y -= 34;
            uClsBtns = new Button[Data.Classes.Length];
            uClsTxt = new Text[Data.Classes.Length];
            float cw = (pw - 48 - (Data.Classes.Length - 1) * 8) / Data.Classes.Length;
            for (int i = 0; i < Data.Classes.Length; i++)
            {
                int idx = i;
                float xc = -pw / 2 + 24 + cw / 2 + i * (cw + 8);
                uClsBtns[i] = MkBtn("cls" + i, pt, Pal.Slate,
                    new Vector2(0.5f, 1), new Vector2(0.5f, 1), new Vector2(0.5f, 1), new Vector2(xc, y), new Vector2(cw, 74),
                    () => clsIdx = idx);
                uClsTxt[i] = MkTxt("t", uClsBtns[i].transform, "", 17, Color.white, TextAnchor.MiddleCenter,
                    Vector2.zero, Vector2.one, new Vector2(0.5f, 0.5f), Vector2.zero, Vector2.zero);
            }
            y -= 92;
            uJoinBtn = MkBtn("join", pt, Pal.Accent,
                new Vector2(0, 1), new Vector2(1, 1), new Vector2(0.5f, 1), new Vector2(0, y), new Vector2(-56, 64), () => Join());
            GlassPanel((Image)uJoinBtn.targetGraphic, new Color(0.7f, 0.95f, 1f, 0.7f));
            AddGlow(uJoinBtn.transform, Pal.Accent, 22);   // 主行动按钮辉光，引导点击
            MkTxt("t", uJoinBtn.transform, "降临次元", 28, Color.white, TextAnchor.MiddleCenter, Vector2.zero, Vector2.one, new Vector2(0.5f, 0.5f), Vector2.zero, Vector2.zero);
            y -= 76;
            MkTxt("hint", pt, "WASD移动 · 右键转视角 · 左键普攻 · QER技能 · 空格翻滚 · F捕捉 · B面板", 15, new Color(0.6f, 0.62f, 0.74f), TextAnchor.UpperCenter,
                new Vector2(0, 1), new Vector2(1, 1), new Vector2(0.5f, 1), new Vector2(0, y), new Vector2(-40, 24));

            // ---- 连接中（带加载转圈，ui-ux-pro-max：异步必须有加载反馈）----
            menuConnecting = MkRect("Conn", root, new Vector2(0.5f, 0.5f), new Vector2(0.5f, 0.5f), new Vector2(0.5f, 0.5f), Vector2.zero, new Vector2(640, 320)).gameObject;
            // 转圈：辉光底 + 旋转拖尾圆环（pivot 居中才能原地自转）
            var spinGlow = MkImg("spinGlow", menuConnecting.transform, new Color(Pal.Accent.r, Pal.Accent.g, Pal.Accent.b, 0.35f),
                new Vector2(0.5f, 1), new Vector2(0.5f, 1), new Vector2(0.5f, 0.5f), new Vector2(0, -64), new Vector2(150, 150));
            spinGlow.sprite = SoftGlowSprite(); spinGlow.raycastTarget = false; spinGlow.gameObject.AddComponent<UiGlowPulse>();
            var spin = MkImg("spinner", menuConnecting.transform, Pal.Accent,
                new Vector2(0.5f, 1), new Vector2(0.5f, 1), new Vector2(0.5f, 0.5f), new Vector2(0, -64), new Vector2(86, 86));
            spin.sprite = SpinnerSprite(); spin.raycastTarget = false; spin.gameObject.AddComponent<UiSpinner>();
            uConnTxt = MkTxt("c", menuConnecting.transform, "正在连接次元…", 32, Color.white, TextAnchor.UpperCenter,
                new Vector2(0, 1), new Vector2(1, 1), new Vector2(0.5f, 1), new Vector2(0, -140), new Vector2(0, 100));
            var cancel = MkBtn("cancel", menuConnecting.transform, new Color(0.5f, 0.2f, 0.22f, 1f),
                new Vector2(0.5f, 0), new Vector2(0.5f, 0), new Vector2(0.5f, 0), new Vector2(0, 26), new Vector2(220, 58),
                () => { try { net?.Close(); } catch { } state = State.Menu; });
            MkTxt("t", cancel.transform, "取消", 24, Color.white, TextAnchor.MiddleCenter, Vector2.zero, Vector2.one, new Vector2(0.5f, 0.5f), Vector2.zero, Vector2.zero);
            menuConnecting.SetActive(false);
        }

        InputField MkInput(Transform parent, string val, int limit, float yy, UnityEngine.Events.UnityAction<string> onChange)
        {
            var bg = Round(MkImg("inp", parent, new Color(0.12f, 0.13f, 0.22f, 1f),
                new Vector2(0, 1), new Vector2(1, 1), new Vector2(0.5f, 1), new Vector2(0, yy), new Vector2(-56, 54)));
            bg.raycastTarget = true;
            var inp = bg.gameObject.AddComponent<InputField>();
            var txt = MkTxt("t", bg.transform, "", 24, Color.white, TextAnchor.MiddleLeft,
                new Vector2(0, 0), new Vector2(1, 1), new Vector2(0.5f, 0.5f), new Vector2(14, 0), new Vector2(-28, -8));
            txt.supportRichText = false;
            inp.textComponent = txt;
            inp.targetGraphic = bg;
            inp.text = val ?? "";
            inp.characterLimit = limit;
            inp.onValueChanged.AddListener(onChange);
            return inp;
        }

        void RefreshMenu(bool playing)
        {
            if (menuCanvas == null) return;
            bool show = !playing;
            if (menuCanvas.enabled != show) menuCanvas.enabled = show;
            if (!show) return;
            uMenuToast.text = Time.time < toastUntil ? toastMsg : "";
            bool connecting = state == State.Connecting;
            if (menuForm.activeSelf == connecting) menuForm.SetActive(!connecting);
            if (menuConnecting.activeSelf != connecting) menuConnecting.SetActive(connecting);
            if (connecting) { uConnTxt.text = $"正在连接次元…\n<size=20>{serverIp}</size>"; return; }
            // 背景光晕跟随所选次元的主色（平滑过渡）
            if (menuGlow != null)
            {
                var a = Data.Dims[dimIdx].accent;
                menuGlow.color = Color.Lerp(menuGlow.color, new Color(a.r, a.g, a.b, 0.24f), 1f - Mathf.Exp(-6f * Time.unscaledDeltaTime));
            }
            for (int i = 0; i < uDimBtns.Length; i++)
                ((Image)uDimBtns[i].targetGraphic).color = i == dimIdx ? Data.Dims[i].accent : Pal.Slate;
            for (int i = 0; i < uClsBtns.Length; i++)
            {
                ((Image)uClsBtns[i].targetGraphic).color = i == clsIdx ? Pal.Gold : Pal.Slate;
                uClsTxt[i].text = $"{Data.ClassTitle(Data.Dims[dimIdx].id, Data.Classes[i].id)}\n<size=14>({Data.Classes[i].role})</size>";
            }
            uHunterHint.text = Data.Dims[dimIdx].id == "hunter" ? "次元天赋：可捕捉野怪当宝宝（F键）" : "";
            // 主行动按钮跟随所选次元主色 —— 不同次元不同风格
            var da = Data.Dims[dimIdx].accent;
            ((Image)uJoinBtn.targetGraphic).color = new Color(da.r, da.g, da.b, 1f);
            uJoinBtn.interactable = (playerName ?? "").Trim().Length > 0;
        }

        // ====================== 背包/商店/属性 面板 ======================
        GameObject uPanel;
        RectTransform uPanelContent;
        Text[] uTabTxt;
        string uPanelSig = "";

        void BuildPanelUI(Transform root)
        {
            // 右上 背包 开关
            var bag = MkBtn("BagBtn", root, Pal.AccentDp,
                new Vector2(1, 1), new Vector2(1, 1), new Vector2(1, 1), new Vector2(-30, -30), new Vector2(76, 76),
                () => panelOpen = !panelOpen);
            GlassPanel((Image)bag.targetGraphic, Pal.Accent);
            BtnIcon(bag.transform, "ui_bag", "背包", 46, 26);
            // 退出
            var exit = MkBtn("ExitBtn", root, new Color(0.52f, 0.20f, 0.27f, 0.96f),
                new Vector2(1, 1), new Vector2(1, 1), new Vector2(1, 1), new Vector2(-116, -30), new Vector2(76, 76),
                () => ExitToMenu());
            GlassPanel((Image)exit.targetGraphic, Pal.Danger);
            BtnIcon(exit.transform, "ui_exit", "退出", 46, 26);

            // 面板（右侧略内缩，避免最右的“关/卖”按钮贴边被裁）
            var panelImg = MkImg("Panel", root, Pal.PanelBg,
                new Vector2(1, 1), new Vector2(1, 1), new Vector2(1, 1), new Vector2(-30, -118), new Vector2(680, 760));
            GlassPanel(panelImg, Pal.Stroke);
            uPanel = panelImg.gameObject;
            uPanel.AddComponent<UiAppear>();
            // 顶部标签
            string[] tabs = { "属性", "背包", "商店" };
            uTabTxt = new Text[tabs.Length];
            float tw = 680f / (tabs.Length + 1);
            for (int i = 0; i < tabs.Length; i++)
            {
                int idx = i;
                var tb = MkBtn("Tab" + i, uPanel.transform, Pal.Slate,
                    new Vector2(0, 1), new Vector2(0, 1), new Vector2(0, 1), new Vector2(i * tw, 0), new Vector2(tw, 56),
                    () => { panelTab = idx; uPanelSig = ""; });
                uTabTxt[i] = MkTxt("t", tb.transform, tabs[i], 22, Color.white, TextAnchor.MiddleCenter, Vector2.zero, Vector2.one, new Vector2(0.5f, 0.5f), Vector2.zero, Vector2.zero);
            }
            var close = MkBtn("Close", uPanel.transform, new Color(0.42f, 0.16f, 0.20f, 1f),
                new Vector2(1, 1), new Vector2(1, 1), new Vector2(1, 1), new Vector2(0, 0), new Vector2(tw, 56), () => panelOpen = false);
            MkTxt("t", close.transform, "关", 24, Color.white, TextAnchor.MiddleCenter, Vector2.zero, Vector2.one, new Vector2(0.5f, 0.5f), Vector2.zero, Vector2.zero);

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

        void RowIcon(Transform row, Color bg, string slot)
        {
            var go = new GameObject("ic", typeof(RectTransform));
            go.transform.SetParent(row, false);
            var le = go.AddComponent<LayoutElement>(); le.minWidth = 40; le.preferredWidth = 40;
            var img = go.AddComponent<Image>();
            var png = PngIcon("slot_" + slot);
            if (png != null) { img.sprite = png; img.color = bg; }          // 白图标按品质色着色
            else { img.sprite = SlotIcon(slot, bg); img.color = Color.white; }
            img.preserveAspect = true; img.raycastTarget = false;
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
            img.raycastTarget = true; Round(img);
            var le = img.gameObject.AddComponent<LayoutElement>(); le.minWidth = 80; le.preferredWidth = 80;
            var b = img.gameObject.AddComponent<Button>(); b.targetGraphic = img;
            var cb = b.colors; cb.highlightedColor = new Color(1.08f, 1.08f, 1.08f, 1f); cb.pressedColor = new Color(1.22f, 1.22f, 1.22f, 1f); cb.fadeDuration = 0.08f; b.colors = cb;
            b.gameObject.AddComponent<UiButtonFx>();
            b.onClick.AddListener(() => onClick());
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
            Line($"<b>{Data.ClassTitle(myDim, myCls)}</b>（{def.role}）");
            Line($"等级 Lv.{you["level"]}（{you["exp"]}/{you["expNeed"]}）");
            Line($"生命：{you["hp"]}/{you["maxHp"]}");
            Line($"物攻 {you["patk"]}    法攻 {you["matk"]}");
            Line($"物防 {you["armor"]}    法防 {you["mres"]}");
            Line($"移速 {you["spd"]}    金币 {you["gold"]}");
            Line($"击杀 野怪{you["kills"]} / 玩家{you["pvpKills"]}");
            Line($"技能点：{MySkPts}");
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
                    if (it == null) { RowIcon(r.transform, new Color(0.32f, 0.33f, 0.4f), slot.Key); RowLabel(r.transform, $"{slot.Value}：<color=#777>空</color>"); }
                    else { RowIcon(r.transform, RarCol(it), slot.Key); RowLabel(r.transform, ItemLine(it)); var sk = slot.Key; RowBtn(r.transform, "卸下", new Color(0.4f, 0.3f, 0.12f), () => Send(new { t = "unequip", slot = sk })); }
                }
            var br = AddRow(30); RowLabel(br.transform, $"<b>背包</b>（{(invData != null ? invData.Count : 0)}/24）");
            if (invData != null)
                for (int i = 0; i < invData.Count; i++)
                {
                    var it = (JObject)invData[i]; int idx = i; int val = (int?)it["val"] ?? 0;
                    var r = AddRow(46);
                    RowIcon(r.transform, RarCol(it), (string)it["slot"] ?? "");
                    RowLabel(r.transform, ItemLine(it));
                    RowBtn(r.transform, "装备", new Color(0.16f, 0.3f, 0.45f), () => Send(new { t = "equip", i = idx }));
                    RowBtn(r.transform, $"卖{val * 2 / 5}", new Color(0.3f, 0.2f, 0.12f), () => Send(new { t = "sell", i = idx }));
                }
        }

        void PanelShop()
        {
            int gold = you != null ? (int?)you["gold"] ?? 0 : 0;
            var hr = AddRow(30); RowLabel(hr.transform, $"<b>商店</b>（{gold}金）");
            if (shopData == null) return;
            foreach (JObject it in shopData)
            {
                var r = AddRow(46);
                RowIcon(r.transform, RarCol(it), (string)it["slot"] ?? "");
                RowLabel(r.transform, ItemLine(it));
                var id = (string)it["id"];
                RowBtn(r.transform, $"{it["price"]}金", new Color(0.32f, 0.28f, 0.12f), () => Send(new { t = "buy", id = id }));
            }
        }
    }

    // ====================== UI 动效组件（纯程序化、零资源依赖，绝不变粉/缺字） ======================

    // 按钮按下回弹：按下缩小、松开带过冲弹性弹回 —— 让每次点击都有“按下去”的反馈感
    public class UiButtonFx : MonoBehaviour, IPointerDownHandler, IPointerUpHandler, IPointerExitHandler
    {
        public float pressScale = 0.93f;   // ui-ux-pro-max scale-feedback：按下回弹保持克制
        Vector3 baseScale = Vector3.one;
        float scale = 1f, vel = 0f, target = 1f;
        bool grabbed;
        void Awake() { baseScale = transform.localScale; if (baseScale == Vector3.zero) baseScale = Vector3.one; }
        public void OnPointerDown(PointerEventData e) { target = pressScale; grabbed = true; }
        public void OnPointerUp(PointerEventData e) { target = 1f; grabbed = false; }
        public void OnPointerExit(PointerEventData e) { if (grabbed) { target = 1f; grabbed = false; } }
        void OnDisable() { scale = 1f; vel = 0f; target = 1f; transform.localScale = baseScale; }
        void Update()
        {
            float dt = Mathf.Min(0.05f, Time.unscaledDeltaTime);
            float a = (target - scale) * 320f - vel * 24f;   // 欠阻尼弹簧 → 轻微回弹
            vel += a * dt; scale += vel * dt;
            transform.localScale = baseScale * scale;
        }
    }

    // 出现动画：缩放 + 淡入（ease-out-back 轻微过冲），用于面板/横幅/弹窗弹出
    public class UiAppear : MonoBehaviour
    {
        public float dur = 0.22f, fromScale = 0.84f;
        CanvasGroup cg; RectTransform rt; float t;
        void OnEnable()
        {
            rt = (RectTransform)transform;
            cg = GetComponent<CanvasGroup>(); if (cg == null) cg = gameObject.AddComponent<CanvasGroup>();
            t = 0f; rt.localScale = new Vector3(fromScale, fromScale, 1f); cg.alpha = 0f;
        }
        void Update()
        {
            if (t >= 1f) return;
            t += Time.unscaledDeltaTime / Mathf.Max(0.02f, dur);
            float k = Mathf.Clamp01(t);
            float s = Mathf.Lerp(fromScale, 1f, EaseOutBack(k));
            rt.localScale = new Vector3(s, s, 1f);
            if (cg != null) cg.alpha = Mathf.Clamp01(k * 1.7f);
            if (t >= 1f) { rt.localScale = Vector3.one; if (cg != null) cg.alpha = 1f; }
        }
        static float EaseOutBack(float x)
        {
            const float c1 = 1.70158f, c3 = c1 + 1f;
            float m = x - 1f;
            return 1f + c3 * m * m * m + c1 * m * m;
        }
    }

    // 持续呼吸缩放（用于登录标题等强调元素，给静态界面一点生气）
    public class UiPulse : MonoBehaviour
    {
        public float amp = 0.035f, speed = 2.2f;
        Vector3 baseScale; float phase;
        void OnEnable() { baseScale = transform.localScale; if (baseScale == Vector3.zero) baseScale = Vector3.one; }
        void Update() { phase += Time.unscaledDeltaTime * speed; float s = 1f + Mathf.Sin(phase) * amp; transform.localScale = baseScale * s; }
    }

    // 呼吸辉光：脉动 Image 的透明度与轻微缩放，做出霓虹光晕（HUD 风格）
    public class UiGlowPulse : MonoBehaviour
    {
        public float min = 0.16f, max = 0.42f, speed = 2.0f, scaleAmp = 0.07f;
        Image img; Color baseCol; Vector3 baseScale; float phase;
        void OnEnable()
        {
            img = GetComponent<Image>(); if (img != null) baseCol = img.color;
            baseScale = transform.localScale; if (baseScale == Vector3.zero) baseScale = Vector3.one;
        }
        void Update()
        {
            phase += Time.unscaledDeltaTime * speed;
            float k = Mathf.Sin(phase) * 0.5f + 0.5f;
            if (img != null) { var c = baseCol; c.a = Mathf.Lerp(min, max, k); img.color = c; }
            transform.localScale = baseScale * (1f + k * scaleAmp);
        }
    }

    // 加载转圈：匀速旋转（配合 SpinnerSprite 的拖尾圆环）
    public class UiSpinner : MonoBehaviour
    {
        public float speed = 240f;
        void Update() { transform.Rotate(0f, 0f, -speed * Time.unscaledDeltaTime); }
    }
}
