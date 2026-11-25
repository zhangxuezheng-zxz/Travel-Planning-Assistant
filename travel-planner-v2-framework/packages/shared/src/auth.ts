import type { Theme, TripPace, TransportMode } from './trips.js';

export interface TravelPreferences {
  themes: Theme[];
  pace: TripPace;
  transportMode: TransportMode;
  dailyBudget: number | null;
}

export interface UpdateProfileRequest {
  displayName?: string;
  bio?: string;
  homeCity?: string;
  travelPreferences?: TravelPreferences;
}

export type ContactChannel = 'email' | 'phone';
export type VerificationPurpose = 'register' | 'verify-email' | 'reset-password';
export interface VerificationResponse {
  message: string;
  retryAfter: number;
  expiresIn: number;
  /** 仅显式启用的本地开发模式返回；生产环境禁止。 */
  developmentCode?: string;
}

export interface PublicUser {
  id: string;
  email: string;
  displayName: string | null;
  emailVerified?: boolean;
  phone?: string | null;
  phoneVerified?: boolean;
  bio?: string;
  homeCity?: string;
  travelPreferences?: TravelPreferences;
}

export interface RegisterRequest {
  email: string;
  password: string;
  displayName: string;
  code: string;
}

export type RegisterResponse = LoginResponse;

export interface LoginRequest {
  email: string;
  password: string;
}

export interface LoginResponse {
  accessToken: string;
  expiresAt: string;
  user: PublicUser;
}

export interface ApiErrorResponse {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}
