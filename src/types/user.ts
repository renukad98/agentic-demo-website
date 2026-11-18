export interface User {
  id: string;
  fullName: string;
  email: string;
  passwordHash: string;
  phone: string;
  address: string;
  createdAt: string;
  updatedAt: string;
  isActive: boolean;
  termsAcceptedAt: string;
  privacyAcknowledgedAt: string;
  legalVersion: string;
}
export function publicUser(user: User) {
  const { passwordHash: _hash, ...safe } = user;
  void _hash;
  return safe;
}
