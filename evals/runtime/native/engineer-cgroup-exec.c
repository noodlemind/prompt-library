#define _GNU_SOURCE 1

#include <errno.h>
#include <limits.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/types.h>
#include <unistd.h>

#if defined(__linux__)
#include <fcntl.h>
#include <grp.h>
#include <linux/capability.h>
#include <linux/magic.h>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <sys/statfs.h>
#include <sys/syscall.h>
#endif

#define MAX_EXEC_ARGS 1024U
#define MAX_TOTAL_ARG_BYTES 1048576U
#define MAX_SINGLE_ARG_BYTES 131072U
#define MAX_SUPPLEMENTARY_GROUPS 64U
#define MAX_PATH_BYTES 4095U
#define MAX_PATH_COMPONENT_BYTES 255U
#define MAX_GROUP_LIST_BYTES 767U

#define CGROUP_ROOT "/sys/fs/cgroup"

enum exit_code {
  EXIT_INVALID_INVOCATION = 64,
  EXIT_INVALID_PLATFORM = 65,
  EXIT_CGROUP_FAILURE = 66,
  EXIT_GROUP_FAILURE = 67,
  EXIT_IDENTITY_FAILURE = 68,
  EXIT_CAPABILITY_FAILURE = 69,
  EXIT_EXEC_FAILURE = 70
};

static const char MESSAGE_INVALID_INVOCATION[] =
  "engineer-cgroup-exec: invalid invocation\n";
static const char MESSAGE_INVALID_PLATFORM[] =
  "engineer-cgroup-exec: trusted Linux root required\n";
#if defined(__linux__)
static const char MESSAGE_CGROUP_FAILURE[] =
  "engineer-cgroup-exec: cgroup attachment failed\n";
static const char MESSAGE_GROUP_FAILURE[] =
  "engineer-cgroup-exec: supplementary group drop failed\n";
static const char MESSAGE_IDENTITY_FAILURE[] =
  "engineer-cgroup-exec: permanent identity drop failed\n";
static const char MESSAGE_CAPABILITY_FAILURE[] =
  "engineer-cgroup-exec: capability confinement failed\n";
static const char MESSAGE_EXEC_FAILURE[] =
  "engineer-cgroup-exec: exact executable failed\n";
#endif

struct invocation {
  uint32_t uid;
  uint32_t gid;
  uint32_t groups[MAX_SUPPLEMENTARY_GROUPS];
  size_t group_count;
  const char *cgroup_path;
  const char *executable;
  char **exec_argv;
};

static _Noreturn void fatal(int code, const char *message) {
  size_t remaining = strlen(message);
  const char *cursor = message;
  while (remaining > 0U) {
    ssize_t written = write(STDERR_FILENO, cursor, remaining);
    if (written > 0) {
      cursor += (size_t)written;
      remaining -= (size_t)written;
      continue;
    }
    if (written < 0 && errno == EINTR) continue;
    break;
  }
  _exit(code);
}

static int bounded_arguments(int argc, char **argv) {
  size_t total = 0U;
  int index;

  if (argc < 1 || argv == NULL || (unsigned int)argc > MAX_EXEC_ARGS + 16U) return 0;
  for (index = 0; index < argc; index += 1) {
    size_t length;
    if (argv[index] == NULL) return 0;
    length = strnlen(argv[index], MAX_SINGLE_ARG_BYTES + 1U);
    if (length > MAX_SINGLE_ARG_BYTES || total > MAX_TOTAL_ARG_BYTES - length - 1U) return 0;
    total += length + 1U;
  }
  return total <= MAX_TOTAL_ARG_BYTES;
}

static int parse_id_slice(const char *text, size_t length, uint32_t *output) {
  uint64_t value = 0U;
  size_t index;

  if (text == NULL || output == NULL || length == 0U || length > 10U) return 0;
  if (length > 1U && text[0] == '0') return 0;
  for (index = 0U; index < length; index += 1U) {
    unsigned char character = (unsigned char)text[index];
    if (character < (unsigned char)'0' || character > (unsigned char)'9') return 0;
    value = (value * 10U) + (uint64_t)(character - (unsigned char)'0');
    if (value >= (uint64_t)UINT32_MAX) return 0;
  }
  *output = (uint32_t)value;
  return 1;
}

static int parse_id(const char *text, uint32_t *output) {
  size_t length;
  if (text == NULL) return 0;
  length = strnlen(text, 11U);
  if (length > 10U) return 0;
  return parse_id_slice(text, length, output);
}

static int parse_groups(const char *text, struct invocation *result) {
  const char *cursor;
  size_t length;

  if (text == NULL || result == NULL) return 0;
  length = strnlen(text, MAX_GROUP_LIST_BYTES + 1U);
  if (length > MAX_GROUP_LIST_BYTES) return 0;
  result->group_count = 0U;
  if (length == 0U) return 1;

  cursor = text;
  while (*cursor != '\0') {
    const char *comma = strchr(cursor, ',');
    size_t token_length = comma == NULL ? strlen(cursor) : (size_t)(comma - cursor);
    uint32_t parsed;
    size_t prior;

    if (result->group_count >= MAX_SUPPLEMENTARY_GROUPS
        || !parse_id_slice(cursor, token_length, &parsed)) return 0;
    for (prior = 0U; prior < result->group_count; prior += 1U) {
      if (result->groups[prior] == parsed) return 0;
    }
    result->groups[result->group_count] = parsed;
    result->group_count += 1U;
    if (comma == NULL) break;
    cursor = comma + 1;
    if (*cursor == '\0') return 0;
  }
  return 1;
}

static int canonical_absolute_path(const char *value) {
  size_t length;
  size_t component_start;
  size_t index;

  if (value == NULL || value[0] != '/') return 0;
  length = strnlen(value, MAX_PATH_BYTES + 1U);
  if (length < 2U || length > MAX_PATH_BYTES || value[length - 1U] == '/') return 0;

  component_start = 1U;
  for (index = 1U; index <= length; index += 1U) {
    if (index < length && value[index] != '/') {
      unsigned char character = (unsigned char)value[index];
      if (character < 0x21U || character > 0x7eU) return 0;
      continue;
    }
    {
      size_t component_length = index - component_start;
      if (component_length == 0U || component_length > MAX_PATH_COMPONENT_BYTES) return 0;
      if ((component_length == 1U && value[component_start] == '.')
          || (component_length == 2U && value[component_start] == '.'
              && value[component_start + 1U] == '.')) return 0;
    }
    component_start = index + 1U;
  }
  return 1;
}

static int canonical_cgroup_path(const char *value) {
  const size_t root_length = sizeof(CGROUP_ROOT) - 1U;
  return canonical_absolute_path(value)
    && strncmp(value, CGROUP_ROOT, root_length) == 0
    && value[root_length] == '/'
    && value[root_length + 1U] != '\0';
}

static int parse_invocation(int argc, char **argv, struct invocation *result) {
  int index = 1;
  int executable_count;

  if (result == NULL || !bounded_arguments(argc, argv)) return 0;
  memset(result, 0, sizeof(*result));

  if (index >= argc || strcmp(argv[index], "--uid") != 0) return 0;
  index += 1;
  if (index >= argc || !parse_id(argv[index], &result->uid)) return 0;
  index += 1;
  if (index >= argc || strcmp(argv[index], "--gid") != 0) return 0;
  index += 1;
  if (index >= argc || !parse_id(argv[index], &result->gid)) return 0;
  index += 1;
  if (index >= argc || strcmp(argv[index], "--groups") != 0) return 0;
  index += 1;
  if (index >= argc || !parse_groups(argv[index], result)) return 0;
  index += 1;

  if (index < argc && strcmp(argv[index], "--cgroup") == 0) {
    index += 1;
    if (index >= argc || !canonical_cgroup_path(argv[index])) return 0;
    result->cgroup_path = argv[index];
    index += 1;
  }

  if (index >= argc || strcmp(argv[index], "--no-new-privileges") != 0) return 0;
  index += 1;
  if (index >= argc || strcmp(argv[index], "--clear-capabilities") != 0) return 0;
  index += 1;
  if (index >= argc || strcmp(argv[index], "--") != 0) return 0;
  index += 1;
  if (index >= argc || !canonical_absolute_path(argv[index])) return 0;

  executable_count = argc - index;
  if (executable_count < 1 || (unsigned int)executable_count > MAX_EXEC_ARGS) return 0;
  result->executable = argv[index];
  result->exec_argv = &argv[index];
  return 1;
}

#if defined(__linux__)

extern char **environ;

static int trusted_cgroup_directory(int descriptor) {
  struct stat metadata;
  struct statfs filesystem;
  if (fstat(descriptor, &metadata) != 0 || !S_ISDIR(metadata.st_mode)) return 0;
  if (metadata.st_uid != 0U || (metadata.st_mode & (mode_t)0022) != 0U) return 0;
  if (fstatfs(descriptor, &filesystem) != 0
      || (unsigned long)filesystem.f_type != (unsigned long)CGROUP2_SUPER_MAGIC) return 0;
  return 1;
}

static int trusted_cgroup_control(int descriptor) {
  struct stat metadata;
  if (fstat(descriptor, &metadata) != 0 || !S_ISREG(metadata.st_mode)) return 0;
  return metadata.st_uid == 0U && (metadata.st_mode & (mode_t)0022) == 0U;
}

static int open_exact_cgroup(const char *path) {
  const size_t root_length = sizeof(CGROUP_ROOT) - 1U;
  const char *cursor = path + root_length + 1U;
  int current = open(CGROUP_ROOT, O_PATH | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);

  if (current < 0 || !trusted_cgroup_directory(current)) {
    if (current >= 0) (void)close(current);
    return -1;
  }

  while (*cursor != '\0') {
    const char *slash = strchr(cursor, '/');
    size_t length = slash == NULL ? strlen(cursor) : (size_t)(slash - cursor);
    char component[MAX_PATH_COMPONENT_BYTES + 1U];
    int next;

    if (length == 0U || length > MAX_PATH_COMPONENT_BYTES) {
      (void)close(current);
      return -1;
    }
    memcpy(component, cursor, length);
    component[length] = '\0';
    next = openat(current, component, O_PATH | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (next < 0 || !trusted_cgroup_directory(next)) {
      if (next >= 0) (void)close(next);
      (void)close(current);
      return -1;
    }
    (void)close(current);
    current = next;
    if (slash == NULL) break;
    cursor = slash + 1;
  }
  return current;
}

static int cgroup_contains_self(int directory, pid_t self) {
  char buffer[65537];
  size_t used = 0U;
  int descriptor = openat(directory, "cgroup.procs", O_RDONLY | O_NOFOLLOW | O_CLOEXEC);

  if (descriptor < 0 || !trusted_cgroup_control(descriptor)) {
    if (descriptor >= 0) (void)close(descriptor);
    return 0;
  }
  for (;;) {
    ssize_t count = read(descriptor, buffer + used, sizeof(buffer) - 1U - used);
    if (count > 0) {
      used += (size_t)count;
      if (used == sizeof(buffer) - 1U) {
        (void)close(descriptor);
        return 0;
      }
      continue;
    }
    if (count < 0 && errno == EINTR) continue;
    if (count < 0) {
      (void)close(descriptor);
      return 0;
    }
    break;
  }
  (void)close(descriptor);
  buffer[used] = '\0';

  {
    char *line = buffer;
    while (*line != '\0') {
      char *end = NULL;
      unsigned long parsed;
      errno = 0;
      parsed = strtoul(line, &end, 10);
      if (errno != 0 || end == line || (*end != '\n' && *end != '\0')) return 0;
      if (parsed == (unsigned long)self) return 1;
      line = *end == '\n' ? end + 1 : end;
    }
  }
  return 0;
}

static int attach_cgroup(const char *path) {
  char pid_text[32];
  int directory = open_exact_cgroup(path);
  int descriptor;
  int length;
  ssize_t written;
  pid_t self = getpid();

  if (directory < 0) return 0;
  descriptor = openat(directory, "cgroup.procs", O_WRONLY | O_NOFOLLOW | O_CLOEXEC);
  if (descriptor < 0 || !trusted_cgroup_control(descriptor)) {
    if (descriptor >= 0) (void)close(descriptor);
    (void)close(directory);
    return 0;
  }
  length = snprintf(pid_text, sizeof(pid_text), "%ld\n", (long)self);
  if (length <= 0 || (size_t)length >= sizeof(pid_text)) {
    (void)close(descriptor);
    (void)close(directory);
    return 0;
  }
  do {
    written = write(descriptor, pid_text, (size_t)length);
  } while (written < 0 && errno == EINTR);
  (void)close(descriptor);
  if (written != (ssize_t)length || !cgroup_contains_self(directory, self)) {
    (void)close(directory);
    return 0;
  }
  (void)close(directory);
  return 1;
}

static int exact_supplementary_groups(const gid_t *expected, size_t count) {
  gid_t observed[MAX_SUPPLEMENTARY_GROUPS];
  int observed_count = getgroups((int)MAX_SUPPLEMENTARY_GROUPS, observed);
  size_t index;
  unsigned char matched[MAX_SUPPLEMENTARY_GROUPS] = { 0U };

  if (observed_count < 0 || (size_t)observed_count != count) return 0;
  for (index = 0U; index < count; index += 1U) {
    int candidate;
    int found = 0;
    for (candidate = 0; candidate < observed_count; candidate += 1) {
      if (matched[candidate] == 0U && observed[candidate] == expected[index]) {
        matched[candidate] = 1U;
        found = 1;
        break;
      }
    }
    if (!found) return 0;
  }
  return 1;
}

static int set_exact_groups(const struct invocation *invocation) {
  gid_t groups[MAX_SUPPLEMENTARY_GROUPS];
  size_t index;
  for (index = 0U; index < invocation->group_count; index += 1U) {
    groups[index] = (gid_t)invocation->groups[index];
    if ((uint64_t)groups[index] != (uint64_t)invocation->groups[index]
        || groups[index] == (gid_t)-1) return 0;
  }
  if (setgroups(invocation->group_count, invocation->group_count == 0U ? NULL : groups) != 0) return 0;
  return exact_supplementary_groups(groups, invocation->group_count);
}

static int clear_ambient_capabilities(void) {
  if (prctl(PR_CAP_AMBIENT, PR_CAP_AMBIENT_CLEAR_ALL, 0L, 0L, 0L) == 0) return 1;
  return errno == EINVAL;
}

static int clear_bounding_capabilities(int *supported_count) {
  int capability;
  for (capability = 0; capability < 1024; capability += 1) {
    int present;
    errno = 0;
    present = prctl(PR_CAPBSET_READ, capability, 0L, 0L, 0L);
    if (present < 0 && errno == EINVAL) {
      if (capability == 0) return 0;
      *supported_count = capability;
      return 1;
    }
    if (present < 0) return 0;
    if (present == 1
        && prctl(PR_CAPBSET_DROP, capability, 0L, 0L, 0L) != 0) return 0;
    if (prctl(PR_CAPBSET_READ, capability, 0L, 0L, 0L) != 0) return 0;
  }
  return 0;
}

static int empty_capability_sets(void) {
  struct __user_cap_header_struct header;
  struct __user_cap_data_struct data[2];
  struct __user_cap_data_struct observed[2];
  size_t index;

  memset(&header, 0, sizeof(header));
  memset(data, 0, sizeof(data));
  memset(observed, 0, sizeof(observed));
  header.version = _LINUX_CAPABILITY_VERSION_3;
  header.pid = 0;
  if (syscall(SYS_capset, &header, data) != 0) return 0;
  if (syscall(SYS_capget, &header, observed) != 0) return 0;
  for (index = 0U; index < 2U; index += 1U) {
    if (observed[index].effective != 0U
        || observed[index].permitted != 0U
        || observed[index].inheritable != 0U) return 0;
  }
  return 1;
}

static int verify_capability_confinement(int supported_count) {
  int capability;
  if (prctl(PR_GET_NO_NEW_PRIVS, 0L, 0L, 0L, 0L) != 1) return 0;
  for (capability = 0; capability < supported_count; capability += 1) {
    int ambient;
    if (prctl(PR_CAPBSET_READ, capability, 0L, 0L, 0L) != 0) return 0;
    errno = 0;
    ambient = prctl(PR_CAP_AMBIENT, PR_CAP_AMBIENT_IS_SET, capability, 0L, 0L);
    if (ambient > 0 || (ambient < 0 && errno != EINVAL)) return 0;
  }
  return 1;
}

static int drop_identity(const struct invocation *invocation) {
  uid_t uid = (uid_t)invocation->uid;
  gid_t gid = (gid_t)invocation->gid;
  uid_t real_uid;
  uid_t effective_uid;
  uid_t saved_uid;
  gid_t real_gid;
  gid_t effective_gid;
  gid_t saved_gid;

  if ((uint64_t)uid != (uint64_t)invocation->uid || uid == (uid_t)-1
      || (uint64_t)gid != (uint64_t)invocation->gid || gid == (gid_t)-1) return 0;
  if (setresgid(gid, gid, gid) != 0
      || getresgid(&real_gid, &effective_gid, &saved_gid) != 0
      || real_gid != gid || effective_gid != gid || saved_gid != gid) return 0;
  if (setresuid(uid, uid, uid) != 0
      || getresuid(&real_uid, &effective_uid, &saved_uid) != 0
      || real_uid != uid || effective_uid != uid || saved_uid != uid) return 0;
  return 1;
}

#endif

int main(int argc, char **argv) {
  struct invocation invocation;

  if (!parse_invocation(argc, argv, &invocation)) {
    fatal(EXIT_INVALID_INVOCATION, MESSAGE_INVALID_INVOCATION);
  }

#if !defined(__linux__)
  (void)invocation;
  fatal(EXIT_INVALID_PLATFORM, MESSAGE_INVALID_PLATFORM);
#else
  {
    int supported_capabilities = 0;

    if (getuid() != 0U || geteuid() != 0U) {
      fatal(EXIT_INVALID_PLATFORM, MESSAGE_INVALID_PLATFORM);
    }
    if (invocation.cgroup_path != NULL && !attach_cgroup(invocation.cgroup_path)) {
      fatal(EXIT_CGROUP_FAILURE, MESSAGE_CGROUP_FAILURE);
    }
    if (!set_exact_groups(&invocation)) {
      fatal(EXIT_GROUP_FAILURE, MESSAGE_GROUP_FAILURE);
    }
    if (!clear_ambient_capabilities()
        || !clear_bounding_capabilities(&supported_capabilities)) {
      fatal(EXIT_CAPABILITY_FAILURE, MESSAGE_CAPABILITY_FAILURE);
    }
    if (!drop_identity(&invocation)) {
      fatal(EXIT_IDENTITY_FAILURE, MESSAGE_IDENTITY_FAILURE);
    }
    if (prctl(PR_SET_NO_NEW_PRIVS, 1L, 0L, 0L, 0L) != 0
        || !empty_capability_sets()
        || !clear_ambient_capabilities()
        || !verify_capability_confinement(supported_capabilities)) {
      fatal(EXIT_CAPABILITY_FAILURE, MESSAGE_CAPABILITY_FAILURE);
    }
    execve(invocation.executable, invocation.exec_argv, environ);
    fatal(EXIT_EXEC_FAILURE, MESSAGE_EXEC_FAILURE);
  }
#endif
}
