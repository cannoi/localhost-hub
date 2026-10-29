# Ofie Hub — báo cáo nâng cấp (đợt đối chiếu & vá lỗi)
Ngày: 2026-10-29

## Bằng chứng kiểm thử (thực tế đã chạy trong môi trường này)
Môi trường **không có mạng** nên không `npm ci`, không Docker: **chưa chạy** typecheck/lint/build/test đầy đủ của dự án.
Đã chạy:
- `node --experimental-strip-types --test src/lib/hub/*.test.ts` → 11/11 pass (access + safety).
- Kiểm tra cú pháp TypeScript (transpile) cho mọi file đã sửa → ok.
- Chạy **engine thật** (biên dịch tạm) với stub `fflate` tối thiểu: 12/12 kịch bản pass (static HTML, ZIP, traversal, ZIP bomb,
  Node app start/HTTP/restart/stop, env child, quyền file, backup, API gate, CSRF) + 2 kiểm tra riêng
  (PID cũ không giết process lạ; state hỏng được giữ bản sao, danh tính persist qua restart).
  Lưu ý: stub không phải `fflate` thật.

## Lỗi thật đã tìm thấy và sửa
| # | Lỗi (trước) | Sửa |
|---|-------------|-----|
| 1 | Quản trị tin `X-Forwarded-For`/`Host`/`Origin` → giả header là vào được; không header = cho phép | `access.ts`: chỉ tin secret hoặc IP peer TCP riêng tư, không relay; peer không rõ → từ chối; so sánh secret hằng thời gian; CSRF same-origin |
| 2 | Có `HUB_SECRET` nhưng LAN vẫn qua không cần secret (Docker gateway trông như LAN) | Có secret ⇒ chỉ secret |
| 3 | `killStale` SIGTERM mọi PID trong `pids.json` (PID tái sử dụng → giết process lạ) | Ghi {pid, start-time, marker}; chỉ kill khi khớp cả 3; định dạng cũ bị bỏ qua |
| 4 | ZIP bomb: giải nén hết rồi mới kiểm tra | Kiểm tra theo `originalSize` trong `filter` trước khi inflate + kiểm tra lại sau |
| 5 | State hỏng ⇒ **âm thầm tạo khóa identity mới** | Giữ `state.json.corrupt-<ts>` trước khi tạo mới + log |
| 6 | `state.json` (chứa private key) quyền mặc định, ghi không atomic | 0600/0700, tmp+rename, `.bak` |
| 7 | Import backup không kiểm slug/tên tệp/chuỗi; không giữ bản cũ | Validate slug, tên tệp, số app, chuỗi ledger (staged + rollback), lưu bản state cũ |
| 8 | Log stream dùng EventSource ⇒ luôn 401 khi có `HUB_SECRET` | `fetch` stream có header; form nhập mật khẩu EN/VI khi 401 |
| 9 | Child app thừa hưởng toàn bộ env (kể cả `HUB_SECRET`) | Env tối thiểu |
| 10 | `/api/chat` và `/health` lộ tên hub, số app, domain cho công khai; chat tin `X-Forwarded-For` | Chỉ trả trạng thái cho caller tin cậy; rate-limit theo peer |
| 11 | Proxy app động giải mã body thành text (hỏng ảnh/nhị phân) | Chuyển nguyên bytes, giới hạn 5MB |
| 12 | `BackupBundle` thiếu `integrity` (typecheck sẽ lỗi); biến thừa | Đã sửa type, bỏ biến thừa |
| 13 | `.github/workflows/docker.yml` báo cáo cũ nói đã thêm nhưng **không có trong zip** | Tạo lại: test → build candidate → smoke (health + 401 gate) → chỉ khi đó push multi-arch |

## Đã giữ nguyên
Dashboard, template/HTML/ZIP, Node/Python, start/stop/restart/delete, vhost, ledger Ed25519, mesh/peer/mirror,
chat EN/VI, giới hạn 8 app, cổng 48080→8080, user không đặc quyền, `no-new-privileges`, `cap_drop ALL`, không Docker socket.
Thay đổi buộc phải có (đã giải thích ở trên): API `importBackup` thành async; `/health` công khai chỉ còn liveness;
đã đặt `HUB_SECRET` thì LAN không còn đủ.

## Trạng thái từng hạng mục
**Implemented and verified (chạy thật, xem trên):** cổng quản trị, giới hạn ZIP/traversal, ownership PID, quyền file, quarantine state, validate backup, env child.
**Implemented, chưa verify đầy đủ:** `peerAddress()` giả định runtime TanStack Start/Nitro đưa socket vào `request` (`request.ip` hoặc `runtime.node.req.socket`) — **nếu không, quản trị bị từ chối cho tới khi đặt `HUB_SECRET`** (fail-closed; cần thử trên container thật); UI unlock + log fetch-stream (chưa chạy trình duyệt); workflow CI (chưa chạy trên GitHub).
**Chưa làm:** Host-header routing cho `customDomain` (hàm có nhưng **không có route nhận `/`** nên chưa hoạt động); ACME/TLS trong Hub; cô lập container từng app; CPU/disk thật; versioning/rollback; health check HTTP định kỳ sau khi chạy; giới hạn restart-loop theo cửa sổ thời gian; log rotation theo dung lượng đĩa; nâng giới hạn 8 app; login/session đầy đủ; nhóm lại navigation theo 9 khu vực; mã hóa dữ liệu lúc nghỉ (không có — backup/state chứa private key dạng PEM).
**Bị chặn bởi môi trường:** `npm ci`/typecheck/lint/build đầy đủ, Docker build/run, GHCR, SoloHost thật, DNS/TLS.

## Vận hành
```
HOST_PORT=48080 HUB_SECRET='<mật-khẩu-dài>' docker compose up -d
curl -s http://127.0.0.1:48080/health
curl -s -H 'x-hub-secret: <mật-khẩu>' http://127.0.0.1:48080/api/hub
```
Backup: tab System → Export (chứa private key — cất offline). Restore: Import (bản state cũ được giữ lại tự động); app động cần Start lại.

## Bước tiếp theo (ưu tiên)
1. `npm ci && npm run typecheck && npm run lint && npm test && npm run build` trên máy có mạng.
2. Chạy container, xác minh `peerAddress()` và 401/200 như workflow smoke.
3. Nối route `/` theo Host cho `customDomain` + test; thêm snippet Caddy/nginx.
4. Health check HTTP định kỳ + giới hạn restart-loop theo cửa sổ thời gian.
5. Versioning/rollback; gộp navigation.
