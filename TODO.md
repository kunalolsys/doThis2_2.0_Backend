# Fix Password Reset in authController.js

## Steps:
- [ ] 1. Delete duplicate file: src/utils/sendVerificationEmail .js (with space)
- [x] 2. Update src/controllers/authController.js:
  - Add input validation for token/newPassword
  - Add debug logging
  - Use save({ validateBeforeSave: false })
  - Extend expiry tolerance
- [ ] 3. Test:
  - Send forgot-password request
  - Use token to reset password
  - Verify new password works on login
- [ ] 4. Check env vars (RESET_URL, EMAIL_USER, EMAIL_PASS)
- [ ] 5. Clean up TODO.md

Current progress: Starting step 1.

