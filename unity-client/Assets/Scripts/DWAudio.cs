/* ============================================================
 * 次元大战 Unity 客户端 - 音频系统（音效 + 背景音乐）
 * 与网页版同一套 CC0 素材（Juhani Junkala），放在 Resources/DWAudio。
 *   SFX(.wav)：swing/laser/explosion/hit/coin/levelup/hurt/click/warhorn/dodge
 *   BGM(.ogg)：bgm_menu / bgm_world / bgm_war
 * 自包含、静态调用，缺素材时静默不报错。静音偏好用 PlayerPrefs 记忆。
 * ============================================================ */
using System.Collections.Generic;
using UnityEngine;

namespace DW
{
    public static class DWAudio
    {
        static GameObject root;
        static AudioSource bgm;
        static AudioSource[] pool;
        static int poolIdx;
        static readonly Dictionary<string, AudioClip> clips = new Dictionary<string, AudioClip>();
        static bool muted;
        static string curBgm;

        static void Ensure()
        {
            if (root != null) return;
            root = new GameObject("DWAudio");
            Object.DontDestroyOnLoad(root);
            bgm = root.AddComponent<AudioSource>();
            bgm.loop = true; bgm.playOnAwake = false; bgm.volume = 0.42f;
            pool = new AudioSource[8];
            for (int i = 0; i < pool.Length; i++) { pool[i] = root.AddComponent<AudioSource>(); pool[i].playOnAwake = false; }
            muted = PlayerPrefs.GetInt("dw_muted", 0) == 1;
            foreach (var c in Resources.LoadAll<AudioClip>("DWAudio")) clips[c.name] = c;
        }

        static AudioClip Get(string name)
        {
            Ensure();
            AudioClip c;
            return clips.TryGetValue(name, out c) ? c : null;
        }

        /* 播放一个音效（轮换音源，可叠加；轻微随机音高防腻） */
        public static void Sfx(string name, float vol = 1f, float pitchVary = 0.08f)
        {
            Ensure();
            if (muted) return;
            var c = Get(name);
            if (c == null) return;
            var src = pool[poolIdx];
            poolIdx = (poolIdx + 1) % pool.Length;
            src.pitch = 1f + Random.Range(-pitchVary, pitchVary);
            src.PlayOneShot(c, vol);
        }

        /* 按距离衰减的音效（远处的爆炸/施法更轻） */
        public static void SfxAt(string name, Vector3 at, Vector3 listener, float vol = 1f)
        {
            float d = Vector3.Distance(at, listener);
            Sfx(name, vol * Mathf.Max(0.12f, 1f - d / 34f));
        }

        /* 切换背景音乐（同名不重复重播） */
        public static void Music(string name)
        {
            Ensure();
            if (curBgm == name) return;
            curBgm = name;
            var c = Get(name);
            bgm.clip = c;
            if (c != null && !muted) bgm.Play();
            else bgm.Stop();
        }

        public static bool ToggleMute()
        {
            Ensure();
            muted = !muted;
            PlayerPrefs.SetInt("dw_muted", muted ? 1 : 0);
            if (muted) bgm.Stop();
            else if (bgm.clip != null) bgm.Play();
            return muted;
        }

        public static bool IsMuted() { Ensure(); return muted; }
    }
}
