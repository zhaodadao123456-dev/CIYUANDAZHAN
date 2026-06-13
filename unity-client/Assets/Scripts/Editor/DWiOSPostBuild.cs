/* ============================================================
 * 次元大战 - iOS 打包后处理
 * 自动给生成的 Xcode 工程 Info.plist 放行明文连接（ws:// http://），
 * 否则装到 iPhone 后连不上服务器（iOS ATS 默认禁止非 HTTPS）。
 * 仅在选择 iOS 平台时编译，其它平台无影响。
 * ============================================================ */
#if UNITY_IOS
using System.IO;
using UnityEditor;
using UnityEditor.Callbacks;
using UnityEditor.iOS.Xcode;

namespace DW.EditorTools
{
    public static class DWiOSPostBuild
    {
        [PostProcessBuild(100)]
        public static void OnPostBuild(BuildTarget target, string pathToBuiltProject)
        {
            if (target != BuildTarget.iOS) return;
            var plistPath = Path.Combine(pathToBuiltProject, "Info.plist");
            if (!File.Exists(plistPath)) return;
            var plist = new PlistDocument();
            plist.ReadFromString(File.ReadAllText(plistPath));
            // 允许明文网络（连你的腾讯云 ws://IP/ws）
            var ats = plist.root.CreateDict("NSAppTransportSecurity");
            ats.SetBoolean("NSAllowsArbitraryLoads", true);
            File.WriteAllText(plistPath, plist.WriteToString());
            UnityEngine.Debug.Log("[DW] 已为 iOS 工程放行明文网络连接 (NSAllowsArbitraryLoads)");
        }
    }
}
#endif
