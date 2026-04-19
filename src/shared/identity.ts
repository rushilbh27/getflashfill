import type { Identity } from './types';
import { faker } from '@faker-js/faker';

export function generateIdentity(domain: string): Identity {
  const firstName = faker.person.firstName();
  const lastName = faker.person.lastName();
  const num = faker.number.int({ min: 100, max: 999 });
  const username = firstName.toLowerCase() + num;
  const email = `${username}@${domain}`;
  return { firstName, lastName, username, email };
}
