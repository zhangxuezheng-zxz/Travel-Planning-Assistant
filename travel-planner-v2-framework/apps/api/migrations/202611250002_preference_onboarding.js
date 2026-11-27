exports.up = (pgm) => {
  // 既有账号无需重新引导；迁移之后注册的账号从未完成状态开始。
  pgm.sql(`ALTER TABLE users ADD COLUMN onboarding_completed_at timestamptz DEFAULT now();
    ALTER TABLE users ALTER COLUMN onboarding_completed_at DROP DEFAULT;`);
};

exports.down = (pgm) => {
  pgm.dropColumns('users', 'onboarding_completed_at');
};
