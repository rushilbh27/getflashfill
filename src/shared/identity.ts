import type { Identity } from './types';
import { faker } from '@faker-js/faker/locale/en';

export function generateIdentity(email: string): Identity {
  const firstName = faker.person.firstName();
  const lastName = faker.person.lastName();
  return {
    email,
    firstName,
    lastName,
    fullName: `${firstName} ${lastName}`,
    username: 'ff' + Date.now().toString(36).slice(-4) + Math.random().toString(36).slice(2, 8),
    password: faker.internet.password({ length: 16, memorable: false, prefix: 'Ff1!' }),
    phone: `(${faker.string.numeric(3)}) ${faker.string.numeric(3)}-${faker.string.numeric(4)}`,
  };
}
