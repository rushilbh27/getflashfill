import { faker } from '@faker-js/faker';
import { Identity } from './types';

export function generateIdentity(email: string): Identity {
  return {
    email,
    firstName: faker.person.firstName(),
    lastName: faker.person.lastName(),
    username: faker.internet.username(),
  };
}
