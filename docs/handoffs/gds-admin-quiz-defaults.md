# Governed defaults for new quizzes

The courses platform policy now contains typed quiz defaults: passing score, time/attempt limits, question/option shuffling, answer visibility, completion requirement and instructor override permission. It uses the existing draft/preview/approval/effective-date lifecycle and role guards. No migration or dependency is added.

Historical course-policy JSON without this optional section remains valid without rewriting its stored content. Compatibility defaults preserve the instructor form's existing70% score,30-minute limit, unlimited attempts, disabled shuffling, visible correct answers, required completion and permitted instructor editing. Configuration uses0 for unlimited time/attempts; stored/API quiz fields use null.

Quiz creation reads effective settings. Omitted fields inherit them; explicit null time/attempt limits mean unlimited. Passing score is now optional on creation, while explicit null is rejected by validation. Instructors may override only when allowed; the backend enforces this independently of disabled UI controls. Platform Admins retain override authority. A policy change does not rewrite existing quizzes. For existing quizzes under locked settings, unchanged values and title/content edits remain allowed; protected changes are rejected against the quiz's existing values.

API clients that previously omitted a time limit now inherit the configured creation default; send null to request unlimited time when overrides are allowed. Existing quiz rows, attempts, grades, course grants and financial data remain unchanged. No business policy is activated by deployment.

Verification: regression first demonstrated missing effective defaults and unguarded overrides. Focused quiz/policy Jest suites and Nest build passed. The disposable PostgreSQL checkout replay now additionally exercises actual policy draft/preview/approval/effectiveness, two successive defaults, instructor API restrictions and retention of a previously created quiz's settings/purchased grants. Its real CI result is a separate gate and is not claimed from local unit checks.
