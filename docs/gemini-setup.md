# Gemini provider setup

EduAI gọi Gemini hoàn toàn ở backend qua SDK chính thức `@google/genai`. Không đưa `GEMINI_API_KEY` vào frontend và không commit file `.env`.

## Tạo API key

1. Mở [Google AI Studio](https://aistudio.google.com/).
2. Tạo hoặc chọn project, sau đó tạo API key.
3. Lưu key trong secret manager hoặc biến môi trường của backend; không dán key vào source code, log, issue hay commit.

## Biến môi trường

Tối thiểu cho local:

```dotenv
AI_PROVIDER=gemini
GEMINI_API_KEY=your-key-from-google-ai-studio
GEMINI_MODEL=gemini-2.5-flash-lite
GEMINI_EMBEDDING_MODEL=gemini-embedding-2
AI_TIMEOUT_MS=60000
AI_MAX_RETRIES=2
```

`GEMINI_API_KEY` và `GEMINI_MODEL` được ưu tiên. Khi `AI_PROVIDER=gemini`, có thể dùng `AI_API_KEY`, `AI_MODEL` và `AI_EMBEDDING_MODEL` làm fallback tương thích. Không fallback sang `OPENAI_API_KEY` hoặc `OPENAI_MODEL`.

`GEMINI_MODEL` là model sinh nội dung; `GEMINI_EMBEDDING_MODEL` là model embedding cho index/RAG hiện có. Chọn model đang được Google hỗ trợ cho Gemini API và giữ nguyên dimension vector hiện tại nếu chưa có migration.

## Local

```powershell
Copy-Item .env.example .env
# điền GEMINI_API_KEY trong .env
npm install
npm run build
npm test -- --runInBand
```

Không cần gọi Gemini khi chạy health check thông thường. Unit test của backend mock toàn bộ request ra Google.

## VPS/Render

Khai báo các biến trên trong Environment/Secrets của service backend. Không upload `.env`, không đưa key vào Docker image và không truyền key qua frontend. Sau khi deploy, kiểm tra log startup và thử endpoint AI đã được bảo vệ bằng authentication; không tạo live health check gọi Gemini để tránh tốn quota.

## Usage, quota và lỗi thường gặp

Kiểm tra Usage/Quota trong Google AI Studio hoặc Google Cloud project tương ứng. Free Tier có quota giới hạn; dữ liệu gửi tới dịch vụ có thể chịu chính sách sử dụng dữ liệu của Google, nên chỉ gửi phần nội dung giáo dục cần thiết và không gửi mật khẩu, token, secret hay thông tin xác thực.

- `401`/`403`: key sai, bị thu hồi, bị chặn hoặc project chưa được cấp quyền.
- `429`: rate limit/quota; backend trả `429` và chỉ retry hữu hạn.
- `404`: model không tồn tại hoặc không được project hỗ trợ.
- `400`: request/schema không hợp lệ hoặc bị safety/policy block.
- timeout/`5xx`: backend áp dụng timeout và exponential backoff giới hạn, sau đó trả lỗi an toàn cho client.

Backend không trả raw SDK error, prompt riêng tư, response nhạy cảm hoặc API key ra frontend/log.

## Đổi provider trong tương lai

Các service/controller nghiệp vụ chỉ phụ thuộc `AI_PROVIDER`. Có thể đặt `AI_PROVIDER=openai` sau khi cung cấp `OPENAI_API_KEY`, `OPENAI_MODEL` và `OPENAI_EMBEDDING_MODEL`; các biến Gemini không được dùng làm fallback cho OpenAI. `AI_PROVIDER=mock` dành cho test/local và không được phép trong production.
