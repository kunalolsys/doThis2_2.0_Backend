export const requirePermission = (permissionKey) => {
  return (req, res, next) => {
    const rolePermissions = req.user?.role?.permissions || [];

    if (!Array.isArray(rolePermissions) || !rolePermissions.includes(permissionKey)) {
      return res.status(403).json({ success: false, message: "Forbidden" });
    }

    return next();
  };
};

