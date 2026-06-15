/* ============================================================
 * 次元大战 - iOS 一键打包辅助
 * 菜单「次元大战 → ④ 准备iOS / ⑤ 导出iOS工程」：
 *   自动建一个空场景并加入 Build Settings（游戏靠 RuntimeInitializeOnLoad 自启动，
 *   但出包仍需至少一个场景）、设置包名/横屏/IL2CPP/自动签名，再导出 Xcode 工程。
 * 注意：真正出包需在你自己的 Mac + Unity(已装 iOS Build Support) 上运行；
 *       导出后用 Xcode 打开、选开发者团队签名、连手机运行。
 * ============================================================ */
using System.IO;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;

namespace DW.EditorTools
{
    public static class DWBuildIOS
    {
        const string ScenePath = "Assets/scenes/DW_Empty.unity";

        [MenuItem("次元大战/④ 准备iOS(空场景+玩家设置)")]
        public static void PrepIOS()
        {
            EnsureScene();
            ConfigPlayer();
            EditorUserBuildSettings.SwitchActiveBuildTarget(BuildTargetGroup.iOS, BuildTarget.iOS);
            EditorUtility.DisplayDialog("次元大战",
                "iOS 准备完成：\n• 已建空场景并加入 Build Settings\n• 已设包名/横屏/IL2CPP/自动签名\n• 已切到 iOS 平台\n\n再点「⑤ 导出iOS工程」，或 File → Build Settings → Build。", "好");
        }

        [MenuItem("次元大战/⑤ 导出iOS工程(Xcode)")]
        public static void BuildIOS()
        {
            EnsureScene();
            ConfigPlayer();
            string outDir = Path.GetFullPath(Path.Combine(Application.dataPath, "..", "iOSBuild"));
            var opt = new BuildPlayerOptions
            {
                scenes = new[] { ScenePath },
                locationPathName = outDir,
                target = BuildTarget.iOS,
                targetGroup = BuildTargetGroup.iOS,
                options = BuildOptions.None,
            };
            try
            {
                var report = BuildPipeline.BuildPlayer(opt);
                if (report.summary.result == UnityEditor.Build.Reporting.BuildResult.Succeeded)
                {
                    EditorUtility.RevealInFinder(outDir);
                    EditorUtility.DisplayDialog("次元大战",
                        $"iOS 工程已导出到:\n{outDir}\n\n用 Xcode 打开里面的 Unity-iPhone.xcodeproj →\n选你的开发者团队(Signing & Capabilities) → 连手机 → ▶ 运行。", "好");
                }
                else
                    EditorUtility.DisplayDialog("次元大战",
                        $"导出失败：{report.summary.result}\n多半是没装 iOS Build Support 模块——用 Unity Hub 给当前 Unity 版本加装 iOS Build Support 后再试。", "好");
            }
            catch (System.Exception e)
            {
                EditorUtility.DisplayDialog("次元大战", "导出出错：\n" + e.Message + "\n\n常见原因：未安装 iOS Build Support 模块。", "好");
            }
        }

        static void EnsureScene()
        {
            if (!File.Exists(ScenePath))
            {
                Directory.CreateDirectory("Assets/scenes");
                var s = EditorSceneManager.NewScene(NewSceneSetup.DefaultGameObjects, NewSceneMode.Single);
                EditorSceneManager.SaveScene(s, ScenePath);
                AssetDatabase.Refresh();
            }
            if (EditorBuildSettings.scenes.Length == 0 || !System.Array.Exists(EditorBuildSettings.scenes, x => x.path == ScenePath))
                EditorBuildSettings.scenes = new[] { new EditorBuildSettingsScene(ScenePath, true) };
        }

        static void ConfigPlayer()
        {
            PlayerSettings.companyName = "DW";
            PlayerSettings.productName = "次元大战";
            PlayerSettings.SetApplicationIdentifier(BuildTargetGroup.iOS, "com.dw.ciyuandazhan");
            PlayerSettings.iOS.targetOSVersionString = "12.0";
            PlayerSettings.iOS.appleEnableAutomaticSigning = true;
            PlayerSettings.defaultInterfaceOrientation = UIOrientation.LandscapeLeft;
            PlayerSettings.SetScriptingBackend(BuildTargetGroup.iOS, ScriptingImplementation.IL2CPP);
        }
    }
}
