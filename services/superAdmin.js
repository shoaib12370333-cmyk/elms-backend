/**
 * The super admin: the owner's account. It is always an admin, and it is the only one who can give the admin panel to
 * another ELMS user or take it away. Nobody can remove the super admin.
 * The address can be changed with SUPER_ADMIN_EMAIL.
 */
const DEFAULT_SUPER_ADMIN_EMAIL = 'shoaib12370333@gmail.com';

function superAdminEmail() {
  return String(process.env.SUPER_ADMIN_EMAIL || DEFAULT_SUPER_ADMIN_EMAIL).trim().toLowerCase();
}

function isSuperAdminEmail(email) {
  return !!email && String(email).trim().toLowerCase() === superAdminEmail();
}

module.exports = { superAdminEmail, isSuperAdminEmail, DEFAULT_SUPER_ADMIN_EMAIL };
