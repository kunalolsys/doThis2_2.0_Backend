import Role from "../models/Role.js";
import { handleAsync } from "../utils/handleAsync.js";
import AppError from "../utils/AppError.js";
import User from "../models/User.js";

// Get all roles
export const getAllRoles = handleAsync(
  async (req, res, next) => {
    const roles = await Role.find({
      name: { $ne: "Super" },
    });

    if (!roles || roles.length === 0) {
      return next(
        new AppError("No roles found", 404)
      );
    }

    return res.status(200).json({
      success: true,
      data: roles,
    });
  }
);
// Create a new role
export const createRole = handleAsync(async (req, res, next) => {
  const { name, permissions } = req.body;
  if (!name) {
    return next(new AppError("Role name is required", 400));
  }

  const newRole = await Role.create({ name, permissions });
  res.status(201).json({ success: true, data: newRole });
});

// Update a role
export const updateRole = handleAsync(async (req, res, next) => {
  const { id } = req.params;
  const { permissions } = req.body;

  const role = await Role.findById(id);

  if (!role) {
    return next(new AppError("Role not found", 404));
  }

  // You might want to add more validation for permissions here
  role.permissions = permissions;
  await role.save();

  res.status(200).json({ success: true, data: role });
});

// Delete a role
export const deleteRole = handleAsync(async (req, res, next) => {
  const { id } = req.params;
  const role = await Role.findById(id);

  if (!role) {
    return next(new AppError("Role not found", 404));
  }

  if (role.canDelete === false) {
    return next(new AppError("This role cannot be deleted", 400));
  }
  const usersWithRole = await User.countDocuments({
    role: id,
    isDeleted: false,
  });
  if (usersWithRole > 0) {
    return next(
      new AppError(
        `Cannot delete role. ${usersWithRole} user(s) still assigned to this role.`,
        400,
      ),
    );
  }
  await role.deleteOne();

  res.status(204).json({ success: true, data: null });
});
