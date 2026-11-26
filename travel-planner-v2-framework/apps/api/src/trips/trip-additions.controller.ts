import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Patch,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthenticatedUser } from '../auth/auth.types';
import { JsonBodyPipe, rejectUnknownFields, requiredString } from '../common/json-body.pipe';
import { TripActivitiesService } from './trip-activities.service';
import { activityInput } from './trip-activity-validation';
import { revision, uuid, validateDates } from './trip-validation';
import { TripsService } from './trips.service';

@Controller('trips/:tripId')
@UseGuards(AuthGuard)
export class TripAdditionsController {
  constructor(
    private readonly activities: TripActivitiesService,
    private readonly trips: TripsService,
  ) {}
  @Get('activity-locations')
  search(
    @CurrentUser() user: AuthenticatedUser,
    @Param('tripId') id: string,
    @Query('keywords') keywords: string,
  ) {
    return this.activities.search(
      user.userId,
      uuid(id, 'tripId'),
      requiredString(keywords, 'keywords', 1, 80),
    );
  }
  @Post('activities')
  @HttpCode(200)
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Param('tripId') id: string,
    @Body(new JsonBodyPipe()) body: Record<string, unknown>,
  ) {
    return this.activities.save(user.userId, uuid(id, 'tripId'), activityInput(body));
  }
  @Patch('activities/:activityId')
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('tripId') id: string,
    @Param('activityId') activityId: string,
    @Body(new JsonBodyPipe()) body: Record<string, unknown>,
  ) {
    return this.activities.save(
      user.userId,
      uuid(id, 'tripId'),
      activityInput(body),
      uuid(activityId, 'activityId'),
    );
  }
  @Delete('activities/:activityId')
  remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('tripId') id: string,
    @Param('activityId') activityId: string,
    @Query('expectedRevision') expected: string,
  ) {
    return this.activities.remove(
      user.userId,
      uuid(id, 'tripId'),
      revision(Number(expected)),
      uuid(activityId, 'activityId'),
    );
  }
  @Post('scenic-stops')
  @HttpCode(200)
  addScenic(
    @CurrentUser() user: AuthenticatedUser,
    @Param('tripId') id: string,
    @Body(new JsonBodyPipe()) body: Record<string, unknown>,
  ) {
    rejectUnknownFields(body, ['expectedRevision', 'placeId', 'date']);
    validateDates(body.date, body.date);
    return this.trips.addScenic(
      user.userId,
      uuid(id, 'tripId'),
      revision(body.expectedRevision),
      uuid(body.placeId, 'placeId'),
      body.date as string,
    );
  }
  @Delete('scenic-stops/:placeId')
  removeScenic(
    @CurrentUser() user: AuthenticatedUser,
    @Param('tripId') id: string,
    @Param('placeId') placeId: string,
    @Query('expectedRevision') expected: string,
  ) {
    return this.trips.removeScenic(
      user.userId,
      uuid(id, 'tripId'),
      revision(Number(expected)),
      uuid(placeId, 'placeId'),
    );
  }
}
