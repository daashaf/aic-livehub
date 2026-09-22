const ADMIN_EMAILS = ["daashaf003@gmail.com", "aic-test-staff-1@example.com", "admin@op.ac.nz"];

export function isAdminEmail(email) {
  return ADMIN_EMAILS.includes((email || "").toLowerCase());
}
