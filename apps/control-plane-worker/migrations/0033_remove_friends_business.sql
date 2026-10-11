-- Remove the deprecated biz-friends business.
-- Migration 0032 already moved all users/members to per-user businesses.
-- Clean up any orphaned rows, then delete the business itself.

-- Remove any leftover business_members rows still pointing to biz-friends
DELETE FROM business_members WHERE business_id = 'biz-friends';

-- Remove any leftover business_integrations rows
DELETE FROM business_integrations WHERE business_id = 'biz-friends';

-- Delete the business row
DELETE FROM businesses WHERE id = 'biz-friends';
