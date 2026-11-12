# Policy JSONB comparison correction

Actual bounded production UAT created an unchanged disabled point-policy draft, but the UI disabled impact preview. JSONB returns object properties in a different order; comparing raw `JSON.stringify` results incorrectly marked unchanged content as edited. The same comparison also affected the backend preview `changed` flag. The owned synthetic draft was cancelled, and effective point settings/version remained unchanged. No policy was activated and no money or point grant was created.

Compare validated JSON objects independently of object-property order, while preserving array ordering, primitive types and values. Frontend edit protection and backend preview now use this contract. No persisted content, policy revision, signature, source digest, approval or financial rule is rewritten. Backend regression first failed for reversed object keys; it passes after the fix and still detects reordered navigation.

Frontend fix and real lifecycle acceptance must deploy separately after required checks. The original GDS migration/card-benefit work remains open; this corrects a prerequisite rather than completing that work.
