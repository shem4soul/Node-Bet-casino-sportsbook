USE casino_sportsbook;

-- Demo admin (password: Admin123! — CHANGE before any real use)
-- Hash below is bcrypt for 'Admin123!' — regenerate in production.
INSERT INTO users (username, email, password_hash, role, kyc_status, status)
VALUES ('admin', 'admin@example.com', '$2a$10$8KQOZ0y0f0N2m0nQe1nZ6uE7f8h8h4o1zC1o1e2s2k2m2m2m2m2m2', 'admin', 'verified', 'active')
ON DUPLICATE KEY UPDATE username = username;

INSERT INTO wallets (user_id, balance)
SELECT id, 0.00 FROM users WHERE username = 'admin'
ON DUPLICATE KEY UPDATE balance = balance;

-- Games
INSERT INTO games (slug, name, type, rtp_percent, min_bet, max_bet, config_json) VALUES
('dice', 'Dice', 'dice', 98.00, 0.50, 1000.00, JSON_OBJECT('houseEdgePercent', 2)),
('coinflip', 'Coin Flip', 'coinflip', 98.00, 0.50, 1000.00, JSON_OBJECT('houseEdgePercent', 2)),
('slots-classic', 'Classic Slots', 'slots', 96.00, 0.20, 500.00,
  JSON_OBJECT(
    'symbols', JSON_ARRAY('CHERRY','LEMON','BELL','STAR','SEVEN'),
    'weights', JSON_ARRAY(40, 30, 15, 10, 5),
    'payouts', JSON_OBJECT('CHERRY', 2, 'LEMON', 3, 'BELL', 5, 'STAR', 10, 'SEVEN', 50)
  )
)
ON DUPLICATE KEY UPDATE slug = slug;

-- Sports / league / sample event
INSERT INTO sports (slug, name) VALUES ('football', 'Football') ON DUPLICATE KEY UPDATE slug = slug;

INSERT INTO leagues (sport_id, slug, name, country)
SELECT id, 'premier-league', 'Premier League', 'England' FROM sports WHERE slug = 'football'
ON DUPLICATE KEY UPDATE slug = slug;

INSERT INTO events (league_id, home_team, away_team, start_time, status)
SELECT l.id, 'Lagos FC', 'Benin City United', DATE_ADD(NOW(), INTERVAL 2 DAY), 'scheduled'
FROM leagues l WHERE l.slug = 'premier-league';

SET @event_id = LAST_INSERT_ID();

INSERT INTO markets (event_id, market_type, status) VALUES (@event_id, '1X2', 'open');
SET @market_id = LAST_INSERT_ID();

INSERT INTO odds (market_id, selection, price_decimal) VALUES
(@market_id, 'HOME', 2.10),
(@market_id, 'DRAW', 3.25),
(@market_id, 'AWAY', 3.40);
