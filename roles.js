// Client-side routing helper only — NOT a security boundary. This decides
// which dashboard a logged-in user lands on (admin-dashboard.html vs
// discover.html). The actual access control lives in firestore.rules, which
// has its own copy of this list (isAdmin()) that must be kept in sync
// manually and redeployed via the Firebase console.
//
// Entries must be lowercase — isAdminEmail() lowercases the input it checks
// against, but not the list itself.
const ADMIN_EMAILS = ["daashaf003@gmail.com", "aic-test-staff-1@example.com", "admin@op.ac.nz"];

export function isAdminEmail(email) {
  return ADMIN_EMAILS.includes((email || "").toLowerCase());
}
