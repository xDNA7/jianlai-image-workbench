//! Pure domain rules. The adapter must persist changes in a database transaction.
//! No HTTP, credentials, file writes, or charges occur in this crate.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Intent {
    Create,
    Edit,
}

/// Editing always delivers one image, even when comparison was selected earlier.
pub fn image_count(intent: Intent, compare: bool) -> u8 {
    match (intent, compare) {
        (Intent::Create, true) => 2,
        _ => 1,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum State {
    Queued,
    Running,
    Done,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Error {
    InvalidCount,
    InsufficientBalance,
    InvalidTransition,
    InvalidDelivery,
    Overflow,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Job {
    state: State,
    requested: u8,
    reserved_cents: u64,
    charged_cents: u64,
}

impl Job {
    pub const PRICE_CENTS: u64 = 30;

    /// `available_cents` must already exclude all other active reservations.
    pub fn reserve(requested: u8, available_cents: u64) -> Result<Self, Error> {
        if !(1..=2).contains(&requested) {
            return Err(Error::InvalidCount);
        }
        let reserved_cents = u64::from(requested) * Self::PRICE_CENTS;
        if reserved_cents > available_cents {
            return Err(Error::InsufficientBalance);
        }
        Ok(Self {
            state: State::Queued,
            requested,
            reserved_cents,
            charged_cents: 0,
        })
    }

    pub fn state(&self) -> State {
        self.state
    }
    pub fn reserved_cents(&self) -> u64 {
        self.reserved_cents
    }
    pub fn charged_cents(&self) -> u64 {
        self.charged_cents
    }

    pub fn start(&mut self) -> Result<(), Error> {
        if self.state != State::Queued {
            return Err(Error::InvalidTransition);
        }
        self.state = State::Running;
        Ok(())
    }

    pub fn expire_queue(&mut self) -> Result<(), Error> {
        if self.state != State::Queued {
            return Err(Error::InvalidTransition);
        }
        self.state = State::Failed;
        self.reserved_cents = 0;
        Ok(())
    }

    /// Count only images validated and atomically published by the storage adapter.
    /// Persist this transition and the ledger debit together; repeated settlement fails.
    pub fn settle(&mut self, delivered: u8) -> Result<u64, Error> {
        if self.state != State::Running {
            return Err(Error::InvalidTransition);
        }
        if delivered > self.requested {
            return Err(Error::InvalidDelivery);
        }
        let cost = u64::from(delivered) * Self::PRICE_CENTS;
        self.charged_cents = cost;
        self.reserved_cents = 0;
        self.state = if delivered == 0 {
            State::Failed
        } else {
            State::Done
        };
        Ok(cost)
    }
}

/// Compute available funds without unsigned underflow or wrapping reservations.
pub fn available(balance: u64, reservations: &[u64]) -> Result<u64, Error> {
    let reserved = reservations.iter().try_fold(0u64, |sum, value| {
        sum.checked_add(*value).ok_or(Error::Overflow)
    })?;
    balance
        .checked_sub(reserved)
        .ok_or(Error::InsufficientBalance)
}
