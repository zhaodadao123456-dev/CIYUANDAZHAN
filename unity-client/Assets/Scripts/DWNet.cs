/* ============================================================
 * 次元大战 Unity 客户端 - WebSocket 网络层
 * 直连 dimensional-war-3d 的 Node.js 服务器（/ws）
 * ============================================================ */
using System;
using System.Collections.Concurrent;
using System.Net.WebSockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace DW
{
    public class Net
    {
        ClientWebSocket ws;
        CancellationTokenSource cts;
        readonly SemaphoreSlim sendLock = new SemaphoreSlim(1, 1);

        public readonly ConcurrentQueue<string> Inbox = new ConcurrentQueue<string>();
        public volatile bool Connected;
        public volatile bool Closed;
        public volatile string LastError = "";

        public async void Connect(string url)
        {
            try
            {
                Closed = false;
                LastError = "";
                cts = new CancellationTokenSource();
                ws = new ClientWebSocket();
                // 连接超时：8 秒连不上就放弃，避免界面无限「降临中」
                using (var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(8)))
                using (var linked = CancellationTokenSource.CreateLinkedTokenSource(cts.Token, timeout.Token))
                {
                    try { await ws.ConnectAsync(new Uri(url), linked.Token); }
                    catch (OperationCanceledException) when (timeout.IsCancellationRequested)
                    { throw new Exception("连接超时：服务器无响应，请检查 IP/端口、服务器是否已启动、安全组是否放行 80 端口"); }
                }
                Connected = true;
                _ = Task.Run(RecvLoop);
            }
            catch (Exception e)
            {
                LastError = e.Message;
                Closed = true;
            }
        }

        async Task RecvLoop()
        {
            var buf = new byte[1 << 16];
            var sb = new StringBuilder();
            try
            {
                while (ws != null && ws.State == WebSocketState.Open)
                {
                    var res = await ws.ReceiveAsync(new ArraySegment<byte>(buf), cts.Token);
                    if (res.MessageType == WebSocketMessageType.Close) break;
                    sb.Append(Encoding.UTF8.GetString(buf, 0, res.Count));
                    if (res.EndOfMessage)
                    {
                        Inbox.Enqueue(sb.ToString());
                        sb.Length = 0;
                    }
                }
            }
            catch (Exception) { /* 断线走统一收尾 */ }
            Connected = false;
            Closed = true;
        }

        public async void Send(string json)
        {
            if (ws == null || ws.State != WebSocketState.Open) return;
            await sendLock.WaitAsync();
            try
            {
                await ws.SendAsync(new ArraySegment<byte>(Encoding.UTF8.GetBytes(json)),
                    WebSocketMessageType.Text, true, CancellationToken.None);
            }
            catch (Exception e) { LastError = e.Message; }
            finally { sendLock.Release(); }
        }

        public void Close()
        {
            try { cts?.Cancel(); ws?.Dispose(); } catch (Exception) { }
            Connected = false;
            Closed = true;
        }
    }
}
