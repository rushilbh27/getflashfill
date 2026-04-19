import type { Identity } from './types';
import { faker } from '@faker-js/faker';

export function generateIdentity(email: string): Identity {
  return {
    email,
    firstName: faker.person.firstName(),
    lastName: faker.person.lastName(),
    username: faker.internet.username(),
  };
}
