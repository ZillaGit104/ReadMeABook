/**
 * Component: User Email Notification Preferences API
 * Documentation: documentation/backend/services/notifications.md
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { AuthenticatedRequest, requireAuth } from '@/lib/middleware/auth';
import { RMABLogger } from '@/lib/utils/logger';

const logger = RMABLogger.create('API.User.NotificationPreferences');

const preferenceFields = {
  notifyRequestPendingApproval: z.boolean(),
  notifyRequestApproved: z.boolean(),
  notifyRequestGrabbed: z.boolean(),
  notifyRequestAvailable: z.boolean(),
  notifyRequestError: z.boolean(),
  notifyRequestCancelled: z.boolean(),
};

const UpdatePreferencesSchema = z.object(preferenceFields).partial().strict()
  .refine((value) => Object.keys(value).length > 0, 'At least one preference is required');

const preferenceSelect = {
  notifyRequestPendingApproval: true,
  notifyRequestApproved: true,
  notifyRequestGrabbed: true,
  notifyRequestAvailable: true,
  notifyRequestError: true,
  notifyRequestCancelled: true,
} as const;

export async function GET(request: NextRequest) {
  return requireAuth(request, async (req: AuthenticatedRequest) => {
    try {
      const user = await prisma.user.findUnique({
        where: { id: req.user!.id },
        select: { plexEmail: true, ...preferenceSelect },
      });

      if (!user) {
        return NextResponse.json({ error: 'User not found' }, { status: 404 });
      }

      const emailBackend = await prisma.notificationBackend.findFirst({
        where: { type: 'email', enabled: true },
        select: { id: true },
      });

      return NextResponse.json({
        success: true,
        email: user.plexEmail,
        emailBackendEnabled: Boolean(emailBackend),
        preferences: {
          notifyRequestPendingApproval: user.notifyRequestPendingApproval,
          notifyRequestApproved: user.notifyRequestApproved,
          notifyRequestGrabbed: user.notifyRequestGrabbed,
          notifyRequestAvailable: user.notifyRequestAvailable,
          notifyRequestError: user.notifyRequestError,
          notifyRequestCancelled: user.notifyRequestCancelled,
        },
      });
    } catch (error) {
      logger.error('Failed to fetch notification preferences', {
        error: error instanceof Error ? error.message : String(error),
      });
      return NextResponse.json(
        { error: 'FetchError', message: 'Failed to fetch notification preferences' },
        { status: 500 }
      );
    }
  });
}

export async function PUT(request: NextRequest) {
  return requireAuth(request, async (req: AuthenticatedRequest) => {
    try {
      const updates = UpdatePreferencesSchema.parse(await req.json());
      const user = await prisma.user.update({
        where: { id: req.user!.id },
        data: updates,
        select: preferenceSelect,
      });

      return NextResponse.json({ success: true, preferences: user });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return NextResponse.json(
          { error: 'ValidationError', details: error.errors },
          { status: 400 }
        );
      }

      logger.error('Failed to update notification preferences', {
        error: error instanceof Error ? error.message : String(error),
      });
      return NextResponse.json(
        { error: 'UpdateError', message: 'Failed to update notification preferences' },
        { status: 500 }
      );
    }
  });
}
