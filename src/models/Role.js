import mongoose from 'mongoose';


const PERMISSIONS = [
   'Setup','Reports','Delegation Task', 'FmsEngine'
];

const FIXED_ROLES = [
  {
    name: 'Admin',
    canDelete: false,
  },
  {
    name: 'Sr. Manager',
    canDelete: false,
  },
  {
    name: 'Manager',
    canDelete: false,
  },
  {
    name: 'Owner',
    canDelete: false,
  },
  {
    name: 'Member',
    canDelete: false,
  },
];

const roleSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    unique: true,
    trim: true
  },
  permissions: [{
    type: String,
    enum: PERMISSIONS
  }],
  canDelete: {
    type: Boolean,
    default: true
  }
}, { timestamps: true });

// Create fixed roles if they don't exist
roleSchema.statics.initializeFixedRoles = async function () {
  for (const fixedRole of FIXED_ROLES) {
    await this.findOneAndUpdate(
      { name: fixedRole.name },
      {
        ...fixedRole,
        canDelete: false
      },
      { upsert: true, new: true }
    );
  }
};

const Role = mongoose.model('Role', roleSchema);
export default Role;