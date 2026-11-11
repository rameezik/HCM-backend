# Enrollment returns 503 after changing the biometric key

An encryption key can have a valid format while being unable to decrypt existing enrollments. Runtime readiness checks model execution and key format; it cannot prove that a newly entered key is the key originally used for stored templates.

During enrollment, the server reads other employees' encrypted templates to prevent duplicate identity registration. A different encryption key makes that check fail. The server rejects the operation and preserves the existing records.

## Restore the existing key

1. In Render → Environment, restore the exact previous `BIOMETRIC_TEMPLATE_KEY` from the deployment's secret backup.
2. If `BIOMETRIC_TEMPLATE_KEY_ID` changed too, restore its previous value. The default is `v1` when no custom version was configured.
3. Save the environment and restart/redeploy the backend so the running process receives the restored settings.
4. Refresh `/admin/attendance-terminal`, confirm the employee's permission and retry **Enable face attendance**.

Do not generate another key for this repair. Do not paste the key into chat, logs or source control. The application cannot reconstruct a lost AES encryption key from ciphertext.

The Admin page distinguishes these failures without exposing keys or encrypted data:

| Code | Meaning | Action |
| --- | --- | --- |
| `BIOMETRIC_TEMPLATE_UNREADABLE` | An existing template could not be decrypted or is damaged. | Restore the original encryption key. If it still fails, investigate the affected enrollment with an authorized operator. |
| `BIOMETRIC_KEY_VERSION_MISMATCH` | A stored template uses a different key version. | Restore the original key and version ID. |
| `BIOMETRIC_NOT_CONFIGURED` | Required biometric configuration is missing or invalid. | Review the Admin readiness panel. |

The application does not ignore unreadable templates, delete employee records or automatically reset enrollments. If the original key is unavailable, an authorized, consented re-enrollment procedure is required separately.

`tests/biometric-key-rotation.test.js` verifies the failure and recovery using actual local inference and an isolated MongoDB database. It also verifies that failed attempts leave existing templates unchanged.
