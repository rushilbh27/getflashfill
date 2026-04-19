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
    username: faker.internet.userName(),
    password: faker.internet.password({ length: 16, memorable: false, prefix: 'Ff1!' }),
  };
}
