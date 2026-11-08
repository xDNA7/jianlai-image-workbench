//! Parameterized SQL catalog. Business services choose operations and bind
//! data; dialect translation, execution, and transaction ownership stay here.

pub mod main {
    pub const SELECT_VIDEO_STATE: &str = "SELECT status FROM video_jobs WHERE id=?";
    pub const SELECT_VIDEO_JOBS_ID: &str = "SELECT created FROM video_jobs WHERE id=?";
    pub const SELECT_AUTHOR_TASKS_ID: &str = "SELECT created FROM author_tasks WHERE id=?";
    pub const SELECT_JOBS_ID: &str = "SELECT created FROM jobs WHERE id=?";
    pub const UPDATE_VIDEO_JOBS_ID_STATUS_QUEUED: &str = "UPDATE video_jobs SET status='failed',phase='failed',reserved=0,error='任务排队超时，未扣费' WHERE id=? AND status='queued'";
    pub const UPDATE_AUTHOR_TASKS_ID_STATUS_RUNNING: &str = "UPDATE author_tasks SET status='failed',updated=?,error='任务排队超时，未扣费' WHERE id=? AND status='running'";
}

pub mod admin {
    pub const SELECT_STORED_IMAGES_DELETED_CREATED: &str =
        "SELECT COUNT(DISTINCT account) FROM stored_images WHERE deleted=0 AND created>?";
    pub const SELECT_JOBS: &str = "SELECT COUNT(*) FROM jobs";
    pub const SELECT_STORED_IMAGES_DELETED_CREATED_2: &str =
        "SELECT COUNT(*) FROM stored_images WHERE deleted=0 AND created>?";
    pub const SELECT_JOBS_STATUS_QUEUED_RUNNING: &str =
        "SELECT COUNT(*) FROM jobs WHERE status IN ('queued','running')";
    pub const SELECT_JOBS_2: &str = "SELECT COALESCE(SUM(charged),0) FROM jobs";
    pub const DELETE_ADMIN_SESSIONS_TOKEN: &str = "DELETE FROM admin_sessions WHERE token=?";
    pub const INSERT_ADMIN_SESSIONS: &str =
        "INSERT INTO admin_sessions(token,csrf,created,expires) VALUES(?,?,?,?)";
    pub const SELECT_ADMIN_SESSIONS_TOKEN_EXPIRES: &str =
        "SELECT token,csrf,expires FROM admin_sessions WHERE token=? AND expires>?";
    pub const SELECT_RECHARGES: &str = "SELECT id,amount,created FROM recharges WHERE requestKey=?";
    pub const SELECT_SHARED_LEDGER_ID: &str = "SELECT balance FROM shared_ledger WHERE id=1";
    pub const INSERT_RECHARGES: &str =
        "INSERT INTO recharges(id,requestKey,amount,created) VALUES(?,?,?,?)";
    pub const UPDATE_SHARED_LEDGER_ID: &str =
        "UPDATE shared_ledger SET balance=balance+? WHERE id=1";
    pub const SELECT_ACCOUNTS: &str = "SELECT a.id,MIN(j.created),MAX(j.created),COUNT(j.id),COALESCE(SUM(j.charged),0) FROM accounts a LEFT JOIN jobs j ON j.account=a.id GROUP BY a.id ORDER BY MAX(j.created) DESC";
    pub const SELECT_STORED_IMAGES_ACCOUNT_DELETED_CREATED: &str =
        "SELECT COUNT(*),MAX(created) FROM stored_images WHERE account=? AND deleted=0 AND created>?";
    pub const SELECT_STORED_IMAGES_I_ACCOUNT_I_DELETED_I: &str = "SELECT i.job,i.idx,i.created,i.hidden,j.params,i.object_url,i.preview_url FROM stored_images i JOIN jobs j ON j.id=i.job WHERE i.account=? AND i.deleted=0 AND i.created>? ORDER BY i.created DESC,i.idx DESC";
}

pub mod api {
    pub const HEALTH: &str = "SELECT 1";
    pub const SELECT_ACCOUNTS_TOKEN: &str = "SELECT id FROM accounts WHERE token=?";
    pub const INSERT_ACCOUNTS: &str = "INSERT INTO accounts(id,token) VALUES(?,?)";
    pub const SELECT_VIDEO_JOBS_ACCOUNT_STATUS_QUEUED_RUNNING_CREATED: &str = "SELECT id FROM video_jobs WHERE account=? AND status IN ('queued','running') ORDER BY created DESC LIMIT 1";
    pub const SELECT_JOBS_ACCOUNT_STATUS_QUEUED_RUNNING_CREATED: &str = "SELECT id FROM jobs WHERE account=? AND (status IN ('queued','running') OR created>?) ORDER BY created DESC LIMIT 1";
    pub const SELECT_VIDEO_JOBS_ACCOUNT_CREATED_CREATED: &str = "SELECT id,status,phase,created,prompt,duration,ratio,resolution,video_url,error,reserved,charged,provider_id,started FROM video_jobs WHERE account=? AND created>? ORDER BY created DESC LIMIT 40";
    pub const SELECT_VIDEO_JOBS_ID: &str = "SELECT account FROM video_jobs WHERE id=?";
    pub const SELECT_JOBS_ID_ACCOUNT: &str = "SELECT 1 FROM jobs WHERE id=? AND account=?";
    pub const UPDATE_STORED_IMAGES_JOB_IDX_ACCOUNT: &str =
        "UPDATE stored_images SET hidden=1 WHERE job=? AND idx=? AND account=?";
}

pub mod images {
    pub const SELECT_JOBS_STATUS_QUEUED_RUNNING: &str =
        "SELECT COALESCE(SUM(reserved),0) FROM jobs WHERE status IN ('queued','running')";
    pub const SELECT_VIDEO_JOBS_STATUS_QUEUED_RUNNING: &str =
        "SELECT COALESCE(SUM(reserved),0) FROM video_jobs WHERE status IN ('queued','running')";
    pub const SELECT_STORED_IMAGES_JOB_DELETED_IDX: &str =
        "SELECT * FROM stored_images WHERE job=? AND deleted=0 ORDER BY idx";
    pub const SELECT_JOBS_ID: &str =
        "SELECT status,charged,created,params,result,phase,requestKey FROM jobs WHERE id=?";
    pub const UPDATE_JOBS_STATUS_QUEUED_CREATED: &str = "UPDATE jobs SET status='failed',reserved=0,phase='failed',result=? WHERE status='queued' AND created<=?";
    pub const SELECT_JOBS_ID_2: &str = "SELECT status,reserved,created FROM jobs WHERE id=?";
    pub const SELECT_STORED_IMAGES_JOB_IDX: &str =
        "SELECT deleted FROM stored_images WHERE job=? AND idx=?";
    pub const UPDATE_SHARED_LEDGER_ID_BALANCE: &str =
        "UPDATE shared_ledger SET balance=balance-? WHERE id=1 AND balance>=?";
    pub const INSERT_STORED_IMAGES: &str = "INSERT OR IGNORE INTO stored_images(job,idx,account,file,type,created,object_url,preview_url) VALUES(?,?,?,?,?,?,?,?)";
    pub const SELECT_JOBS_ID_3: &str = "SELECT params FROM jobs WHERE id=?";
    pub const UPDATE_JOBS_ID: &str =
        "UPDATE jobs SET status=?,phase=?,charged=?,reserved=0,result=?,params=? WHERE id=?";
    pub const UPDATE_JOBS_ID_STATUS_QUEUED_CREATED: &str = "UPDATE jobs SET status='running',phase='generating',started=? WHERE id=? AND status='queued' AND created>?";
    pub const SELECT_JOBS_ID_4: &str = "SELECT account FROM jobs WHERE id=?";
    pub const UPDATE_JOBS_ID_STATUS_RUNNING: &str =
        "UPDATE jobs SET phase='saving' WHERE id=? AND status='running'";
    pub const SELECT_JOBS_ID_5: &str = "SELECT status,phase,charged,result FROM jobs WHERE id=?";
    pub const UPDATE_JOBS_ACCOUNT_ADMIN_TEMPLATE_AUTHORING_STATUS: &str = "UPDATE jobs SET status='failed',reserved=0,phase='failed',result=? WHERE account='admin-template-authoring' AND status IN ('queued','running')";
    pub const UPDATE_AUTHOR_TASKS_STATUS_RUNNING: &str = "UPDATE author_tasks SET status='failed',updated=?,error='服务重启，模板任务未完成，未扣费' WHERE status='running'";
    pub const SELECT_JOBS_STATUS_QUEUED_RUNNING_ACCOUNT_ADMIN: &str = "SELECT id,account,params FROM jobs WHERE status IN ('queued','running') AND (?=1 OR (account!='admin-template-authoring' AND status='running' AND ((started IS NULL AND created<=?) OR started<=?)))";
    pub const SELECT_STORED_IMAGES_JOB_IDX_2: &str =
        "SELECT * FROM stored_images WHERE job=? AND idx=?";
    pub const UPDATE_STORED_IMAGES_JOB_IDX: &str =
        "UPDATE stored_images SET deleted=1,hidden=1 WHERE job=? AND idx=?";
    pub const SELECT_STORED_IMAGES_CREATED_DELETED_HIDDEN: &str =
        "SELECT * FROM stored_images WHERE created<=? AND (deleted=0 OR hidden=1)";
    pub const DELETE_ADMIN_SESSIONS_EXPIRES: &str = "DELETE FROM admin_sessions WHERE expires<=?";
    pub const SELECT_STORED_IMAGES_I_ACCOUNT_I_DELETED_I: &str = "SELECT i.*,j.params FROM stored_images i JOIN jobs j ON j.id=i.job WHERE i.account=? AND i.deleted=0 AND i.hidden=0 AND i.created>? AND (i.created<? OR (i.created=? AND i.job<?) OR (i.created=? AND i.job=? AND i.idx<?)) ORDER BY i.created DESC,i.job DESC,i.idx DESC LIMIT ?";
    pub const SELECT_STORED_IMAGES_ACCOUNT_DELETED_HIDDEN_CREATED: &str = "SELECT COUNT(*) FROM stored_images WHERE account=? AND deleted=0 AND hidden=0 AND created>?";
}

pub mod video {
    pub const SELECT_VIDEO_JOBS_ID: &str = "SELECT status,reserved FROM video_jobs WHERE id=?";
    pub const UPDATE_VIDEO_JOBS_ID: &str = "UPDATE video_jobs SET status=?,phase=?,reserved=0,charged=?,video_url=?,error=? WHERE id=?";
    pub const SELECT_VIDEO_JOBS_ID_2: &str = "SELECT input_key,account FROM video_jobs WHERE id=?";
    pub const UPDATE_VIDEO_JOBS_ID_ACCOUNT: &str =
        "UPDATE video_jobs SET input_key=NULL,input_url=NULL WHERE id=? AND account=?";
    pub const SELECT_VIDEO_JOBS_ID_3: &str = "SELECT status FROM video_jobs WHERE id=?";
    pub const UPDATE_VIDEO_JOBS_ID_2: &str = "UPDATE video_jobs SET status='running',phase=CASE WHEN provider_id IS NULL THEN 'submitting' ELSE 'generating' END,started=COALESCE(started,?) WHERE id=?";
    pub const SELECT_VIDEO_JOBS_ID_4: &str =
        "SELECT prompt,duration,ratio,resolution,input_key FROM video_jobs WHERE id=?";
    pub const SELECT_VIDEO_JOBS_ID_5: &str = "SELECT provider_id FROM video_jobs WHERE id=?";
    pub const UPDATE_VIDEO_JOBS_ID_3: &str =
        "UPDATE video_jobs SET phase='generating',provider_id=? WHERE id=?";
    pub const UPDATE_VIDEO_JOBS_ID_4: &str = "UPDATE video_jobs SET phase='generating' WHERE id=?";
    pub const SELECT_VIDEO_JOBS_STATUS_QUEUED_RUNNING_PROVIDER_ID_STARTED: &str = "SELECT id,reserved FROM video_jobs WHERE status IN ('queued','running') AND (provider_id IS NULL OR started IS NULL OR started<?)";
    pub const UPDATE_VIDEO_JOBS_ID_5: &str = "UPDATE video_jobs SET status='failed',phase='failed',reserved=0,error='服务重启期间任务尚未提交，额度已退回' WHERE id=?";
    pub const SELECT_VIDEO_JOBS_STATUS_RUNNING_PROVIDER_ID_STARTED: &str = "SELECT id FROM video_jobs WHERE status IN ('queued','running') AND provider_id IS NOT NULL ORDER BY started";
    pub const SELECT_VIDEO_JOBS_STATUS_DONE_FAILED_CREATED_VIDEO_URL: &str = "SELECT id,video_url FROM video_jobs WHERE status IN ('done','failed') AND created<=? AND (video_url IS NOT NULL OR input_key IS NOT NULL)";
    pub const UPDATE_VIDEO_JOBS_ID_6: &str = "UPDATE video_jobs SET video_url=NULL,input_url=NULL,input_key=NULL,prompt='',error=CASE WHEN error='' THEN '视频已过期' ELSE error END,phase='expired' WHERE id=?";
}

pub mod templates {
    pub const SELECT_TEMPLATE_ASSETS_ID: &str = "SELECT 1 FROM template_assets WHERE id=?";
    pub const SELECT_TEMPLATE_ASSETS_ID_2: &str =
        "SELECT file,type,object_url,preview_url FROM template_assets WHERE id=?";
    pub const INSERT_TEMPLATE_ASSETS: &str = "INSERT INTO template_assets(id,file,type,created,task,object_url,preview_url) VALUES(?,?,?,?,?,?,?)";
    pub const SELECT_AUTHOR_TASKS_ID: &str =
        "SELECT mode,status,created,updated,result,error,jobId FROM author_tasks WHERE id=?";
    pub const SELECT_JOBS_ID: &str = "SELECT charged FROM jobs WHERE id=?";
    pub const SELECT_AUTHOR_TASKS: &str =
        "SELECT id,fingerprint FROM author_tasks WHERE requestKey=?";
    pub const SELECT_AUTHOR_TASKS_STATUS_RUNNING: &str =
        "SELECT 1 FROM author_tasks WHERE status='running'";
    pub const INSERT_ACCOUNTS: &str = "INSERT OR IGNORE INTO accounts(id,token) VALUES('admin-template-authoring','admin-author-token')";
    pub const INSERT_JOBS: &str = "INSERT INTO jobs(id,account,requestKey,status,created,params,result,reserved) VALUES(?,'admin-template-authoring',?,'queued',?,?,'{}',30)";
    pub const INSERT_AUTHOR_TASKS: &str = "INSERT INTO author_tasks(id,requestKey,mode,status,created,updated,jobId,fingerprint) VALUES(?,?,?,'running',?,?,?,?)";
    pub const UPDATE_JOBS_ID_STATUS_RUNNING_RESERVED: &str = "UPDATE jobs SET status='done',phase='done',charged=30,reserved=0,result='{}' WHERE id=? AND status='running' AND reserved=30";
    pub const UPDATE_SHARED_LEDGER_ID_BALANCE: &str =
        "UPDATE shared_ledger SET balance=balance-30 WHERE id=1 AND balance>=30";
    pub const UPDATE_AUTHOR_TASKS_ID_STATUS_RUNNING: &str = "UPDATE author_tasks SET status='done',updated=?,result=?,assetId=? WHERE id=? AND status='running'";
    pub const UPDATE_AUTHOR_TASKS_ID_STATUS_RUNNING_2: &str =
        "UPDATE author_tasks SET status='failed',updated=?,error=? WHERE id=? AND status='running'";
    pub const UPDATE_JOBS_ID_STATUS_QUEUED_RUNNING: &str = "UPDATE jobs SET status='failed',phase='failed',reserved=0,result=? WHERE id=? AND status IN ('queued','running')";
    pub const SELECT_TEMPLATE_ASSETS_CREATED: &str =
        "SELECT id,file,object_url,preview_url FROM template_assets WHERE created<?";
    pub const DELETE_TEMPLATE_ASSETS_ID: &str = "DELETE FROM template_assets WHERE id=?";
}

pub mod generation {
    pub const SELECT_VIDEO_JOBS_ID: &str = "SELECT account,status,phase,created,prompt,duration,ratio,resolution,video_url,error,reserved,charged,provider_id,started FROM video_jobs WHERE id=?";
}

pub mod submissions {
    pub const SELECT_VIDEO_JOBS_ACCOUNT: &str =
        "SELECT id,fingerprint FROM video_jobs WHERE account=? AND requestKey=?";
    pub const SELECT_JOBS_ACCOUNT_STATUS_QUEUED_RUNNING: &str = "SELECT 1 FROM jobs WHERE account=? AND status IN ('queued','running') UNION ALL SELECT 1 FROM video_jobs WHERE account=? AND status IN ('queued','running') LIMIT 1";
    pub const SELECT_VIDEO_JOBS_STATUS_QUEUED: &str =
        "SELECT COUNT(*) FROM video_jobs WHERE status='queued'";
    pub const INSERT_VIDEO_JOBS: &str = "INSERT INTO video_jobs(id,account,requestKey,fingerprint,status,phase,created,reserved,prompt,duration,ratio,resolution,input_key) VALUES(?,?,?,?,'queued','queued',?,?,?,?,?,?,?)";
    pub const UPDATE_VIDEO_JOBS_ID: &str = "UPDATE video_jobs SET status='failed',phase='failed',reserved=0,error='首帧暂存失败，额度未扣费' WHERE id=?";
    pub const UPDATE_VIDEO_JOBS_ID_2: &str = "UPDATE video_jobs SET status='failed',phase='failed',reserved=0,error='任务调度失败，未扣费' WHERE id=?";
    pub const SELECT_JOBS_ACCOUNT: &str =
        "SELECT id,fingerprint FROM jobs WHERE account=? AND requestKey=?";
    pub const INSERT_JOBS: &str = "INSERT INTO jobs(id,account,requestKey,status,created,params,result,reserved,fingerprint) VALUES(?,?,?,'queued',?,?,'{}',?,?)";
    pub const UPDATE_JOBS_ID: &str =
        "UPDATE jobs SET status='failed',reserved=0,result=? WHERE id=?";
}

pub const ALL: &[&str] = &[
    main::SELECT_VIDEO_STATE,
    api::HEALTH,
    main::SELECT_VIDEO_JOBS_ID,
    main::SELECT_AUTHOR_TASKS_ID,
    main::SELECT_JOBS_ID,
    main::UPDATE_VIDEO_JOBS_ID_STATUS_QUEUED,
    main::UPDATE_AUTHOR_TASKS_ID_STATUS_RUNNING,
    admin::SELECT_STORED_IMAGES_DELETED_CREATED,
    admin::SELECT_JOBS,
    admin::SELECT_STORED_IMAGES_DELETED_CREATED_2,
    admin::SELECT_JOBS_STATUS_QUEUED_RUNNING,
    admin::SELECT_JOBS_2,
    admin::DELETE_ADMIN_SESSIONS_TOKEN,
    admin::INSERT_ADMIN_SESSIONS,
    admin::SELECT_ADMIN_SESSIONS_TOKEN_EXPIRES,
    admin::SELECT_RECHARGES,
    admin::SELECT_SHARED_LEDGER_ID,
    admin::INSERT_RECHARGES,
    admin::UPDATE_SHARED_LEDGER_ID,
    admin::SELECT_ACCOUNTS,
    admin::SELECT_STORED_IMAGES_ACCOUNT_DELETED_CREATED,
    admin::SELECT_STORED_IMAGES_I_ACCOUNT_I_DELETED_I,
    api::SELECT_ACCOUNTS_TOKEN,
    api::INSERT_ACCOUNTS,
    api::SELECT_VIDEO_JOBS_ACCOUNT_STATUS_QUEUED_RUNNING_CREATED,
    api::SELECT_JOBS_ACCOUNT_STATUS_QUEUED_RUNNING_CREATED,
    api::SELECT_VIDEO_JOBS_ACCOUNT_CREATED_CREATED,
    api::SELECT_VIDEO_JOBS_ID,
    api::SELECT_JOBS_ID_ACCOUNT,
    api::UPDATE_STORED_IMAGES_JOB_IDX_ACCOUNT,
    images::SELECT_JOBS_STATUS_QUEUED_RUNNING,
    images::SELECT_VIDEO_JOBS_STATUS_QUEUED_RUNNING,
    images::SELECT_STORED_IMAGES_JOB_DELETED_IDX,
    images::SELECT_JOBS_ID,
    images::UPDATE_JOBS_STATUS_QUEUED_CREATED,
    images::SELECT_JOBS_ID_2,
    images::SELECT_STORED_IMAGES_JOB_IDX,
    images::UPDATE_SHARED_LEDGER_ID_BALANCE,
    images::INSERT_STORED_IMAGES,
    images::SELECT_JOBS_ID_3,
    images::UPDATE_JOBS_ID,
    images::UPDATE_JOBS_ID_STATUS_QUEUED_CREATED,
    images::SELECT_JOBS_ID_4,
    images::UPDATE_JOBS_ID_STATUS_RUNNING,
    images::SELECT_JOBS_ID_5,
    images::UPDATE_JOBS_ACCOUNT_ADMIN_TEMPLATE_AUTHORING_STATUS,
    images::UPDATE_AUTHOR_TASKS_STATUS_RUNNING,
    images::SELECT_JOBS_STATUS_QUEUED_RUNNING_ACCOUNT_ADMIN,
    images::SELECT_STORED_IMAGES_JOB_IDX_2,
    images::UPDATE_STORED_IMAGES_JOB_IDX,
    images::SELECT_STORED_IMAGES_CREATED_DELETED_HIDDEN,
    images::DELETE_ADMIN_SESSIONS_EXPIRES,
    images::SELECT_STORED_IMAGES_I_ACCOUNT_I_DELETED_I,
    images::SELECT_STORED_IMAGES_ACCOUNT_DELETED_HIDDEN_CREATED,
    video::SELECT_VIDEO_JOBS_ID,
    video::UPDATE_VIDEO_JOBS_ID,
    video::SELECT_VIDEO_JOBS_ID_2,
    video::UPDATE_VIDEO_JOBS_ID_ACCOUNT,
    video::SELECT_VIDEO_JOBS_ID_3,
    video::UPDATE_VIDEO_JOBS_ID_2,
    video::SELECT_VIDEO_JOBS_ID_4,
    video::SELECT_VIDEO_JOBS_ID_5,
    video::UPDATE_VIDEO_JOBS_ID_3,
    video::UPDATE_VIDEO_JOBS_ID_4,
    video::SELECT_VIDEO_JOBS_STATUS_QUEUED_RUNNING_PROVIDER_ID_STARTED,
    video::UPDATE_VIDEO_JOBS_ID_5,
    video::SELECT_VIDEO_JOBS_STATUS_RUNNING_PROVIDER_ID_STARTED,
    video::SELECT_VIDEO_JOBS_STATUS_DONE_FAILED_CREATED_VIDEO_URL,
    video::UPDATE_VIDEO_JOBS_ID_6,
    templates::SELECT_TEMPLATE_ASSETS_ID,
    templates::SELECT_TEMPLATE_ASSETS_ID_2,
    templates::INSERT_TEMPLATE_ASSETS,
    templates::SELECT_AUTHOR_TASKS_ID,
    templates::SELECT_JOBS_ID,
    templates::SELECT_AUTHOR_TASKS,
    templates::SELECT_AUTHOR_TASKS_STATUS_RUNNING,
    templates::INSERT_ACCOUNTS,
    templates::INSERT_JOBS,
    templates::INSERT_AUTHOR_TASKS,
    templates::UPDATE_JOBS_ID_STATUS_RUNNING_RESERVED,
    templates::UPDATE_SHARED_LEDGER_ID_BALANCE,
    templates::UPDATE_AUTHOR_TASKS_ID_STATUS_RUNNING,
    templates::UPDATE_AUTHOR_TASKS_ID_STATUS_RUNNING_2,
    templates::UPDATE_JOBS_ID_STATUS_QUEUED_RUNNING,
    templates::SELECT_TEMPLATE_ASSETS_CREATED,
    templates::DELETE_TEMPLATE_ASSETS_ID,
    generation::SELECT_VIDEO_JOBS_ID,
    submissions::SELECT_VIDEO_JOBS_ACCOUNT,
    submissions::SELECT_JOBS_ACCOUNT_STATUS_QUEUED_RUNNING,
    submissions::SELECT_VIDEO_JOBS_STATUS_QUEUED,
    submissions::INSERT_VIDEO_JOBS,
    submissions::UPDATE_VIDEO_JOBS_ID,
    submissions::UPDATE_VIDEO_JOBS_ID_2,
    submissions::SELECT_JOBS_ACCOUNT,
    submissions::INSERT_JOBS,
    submissions::UPDATE_JOBS_ID,
];
