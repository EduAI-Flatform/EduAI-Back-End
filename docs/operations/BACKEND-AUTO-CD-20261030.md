# EduAI Backend — vận hành CD tự động sau Neon Launch (30/10/2026)

## Trạng thái xác minh

- Neon project `muddy-term-45367509`, branch `production`, database `neondb`: chủ dự án đã nâng lên **Launch**; Neon Console xác minh gói Launch.
- Có hai snapshot thủ công của branch, được tạo ngày 26/10 và 30/10, cùng hiển thị `Expires on: never`. Đây không thay thế việc diễn tập khôi phục.
- Ba migration additive đã áp dụng trong lượt CD #159 attempt 1 ngày 30/10, ledger có `finished_at` và không có `rolled_back_at`:
  - `20261023010000_add_bank_receipt_claims`
  - `20261023020000_add_receipt_access`
  - `20261023021000_add_receipt_quota_pools`
- Lượt #159 attempt 1 dừng sau khi apply vì `MIGRATION_FINANCIAL_STATE_CHANGED` trong hậu kiểm. **Chưa xác định được bảng nào thay đổi**, không suy diễn nguyên nhân; chốt bảo vệ không bị gỡ.
- [Lượt chạy lại #159 attempt 2](https://github.com/EduAI-Flatform/EduAI-Back-End/actions/runs/40992759128) PASS. Có `migrationApply: SKIPPED_ALREADY_APPLIED`, `migrationPostflight: PASS`, `financialRowsChanged: 0`, `runtimeRoleLeastPrivilegeReady: true`, PM2 restart và backend readiness PASS. SHA trên VPS `352bd4b8cb245c180bbddca81152558454ca4dff`.
- API `/health` được xác minh trả `status: ok`, Redis `ok`.
- GitHub Actions repository variable `EDUAI_AUTO_CD_ENABLED=true` được đặt sau lượt triển khai thủ công PASS. `push` lên `main` chạy workflow; job deploy chỉ có hiệu lực khi biến còn bằng `true`.

## Giới hạn an toàn

1. CD tự động **không cấp quyền** áp dụng migration receipt mới/chưa phê duyệt; các chốt fingerprint/ledger/preflight/postflight và phân quyền DB vẫn giữ. Nếu phát hiện drift hoặc migration không được duyệt, CD phải fail closed.
2. **Không** sử dụng `authorize_receipt_schema_migrations` khi deploy tự động; input này chỉ dành cho lượt thủ công được chủ dự án duyệt.
3. CD không thay `.env`, không bật thanh toán MB thật từ ảnh, không gỡ yêu cầu hai Admin, không mở Ví GDS, không mở `SPR25-007`.
4. Một CD PASS chứng minh nguồn/ứng dụng/health, **không** chứng minh thanh toán thật, đối soát tiền về hay dữ liệu ngân hàng.

## Dừng khẩn cấp và kiểm tra

- Đặt repository variable `EDUAI_AUTO_CD_ENABLED=false` (hoặc xóa biến) để các lần `push` tiếp theo không chạy job deploy; workflow CI vẫn chạy.
- Xem `Actions → Deploy Backend Production`, đối chiếu commit `main`, `Deploy to VPS`, `deployedBackendSha`, `migrationPostflight`, `financialRowsChanged`, quyền runtime và readiness.
- Nếu job báo `MIGRATION_FINANCIAL_STATE_CHANGED`, **không** sửa ledger, bỏ guard, tự động retry vô hạn hoặc coi kết quả là PASS. Điều tra dữ liệu/cạnh tranh giao dịch rồi mới rerun có kiểm soát.
- Trước khi phát hành thanh toán công khai cần hoàn tất GO-LIVE gate riêng; `SPR25-007` vẫn giữ trạng thái chặn.
